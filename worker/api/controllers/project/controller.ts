import { BaseController } from '../baseController';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { createLogger } from '../../../logger';
import { UserService } from '../../../database/services/UserService';
import { AppService } from '../../../database/services/AppService';
import { ModelConfigService } from '../../../database/services/ModelConfigService';
import { RateLimitService } from '../../../services/rate-limit/rateLimits';
import { sha256Hash } from '../../../utils/cryptoUtils';
import { generateId } from '../../../utils/idGenerator';
import {
	getAgentStub,
	getAgentState,
	getTemplateForQuery,
} from '../../../agents/index';
import { getSandboxService } from '../../../services/sandbox/factory';
import type { CodeGenState } from '../../../agents/core/state';
import type { InferenceContext } from '../../../agents/inferutils/config.types';

export class ProjectController extends BaseController {
	static logger = createLogger('ProjectController');

	/**
	 * Validate API key from Authorization header against env.API_KEY
	 * Uses timing-safe comparison to prevent timing attacks
	 */
	private static async validateApiKey(
		request: Request,
		env: Env,
	): Promise<boolean> {
		const authHeader = request.headers.get('Authorization');
		if (!authHeader?.startsWith('Bearer ')) {
			this.logger.warn('Missing or invalid Authorization header');
			return false;
		}

		const providedKey = authHeader.substring(7);
		const expectedKey = env.API_KEY;

		if (!expectedKey) {
			this.logger.error('API_KEY not configured in environment');
			return false;
		}

		// Timing-safe comparison using SHA-256 hashes
		const providedHash = await sha256Hash(providedKey);
		const expectedHash = await sha256Hash(expectedKey);

		return providedHash === expectedHash;
	}

	static async createOrGetUser(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<ControllerResponse<ApiResponse<UserData>>> {
		try {
			// Validate API key
			if (!(await this.validateApiKey(request, env))) {
				return this.createErrorResponse(
					'Invalid or missing API key',
					401,
				);
			}

			// Parse request body
			const bodyResult = await this.parseJsonBody<{
				email: string;
				name: string;
			}>(request);
			if (!bodyResult.success) {
				return bodyResult.response!;
			}

			const { email, name } = bodyResult.data!;

			// Validate required fields
			if (!email || !name) {
				return this.createErrorResponse(
					'Email and name are required',
					400,
				);
			}

			// Validate email format
			const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
			if (!emailRegex.test(email)) {
				return this.createErrorResponse(
					'Invalid email format',
					400,
				);
			}

			// Check if user exists
			const userService = new UserService(env);
			let user = await userService.findUser({
				email: email.toLowerCase(),
			});

			if (!user) {
				// Create new user
				user = await userService.createUser({
					email: email.toLowerCase(),
					displayName: name,
					provider: 'email',
					providerId: email.toLowerCase(),
					emailVerified: true,
					isActive: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				});

				this.logger.info('Created new user via API', {
					userId: user.id,
					email,
				});
			} else {
				this.logger.info('Returning existing user via API', {
					userId: user.id,
					email,
				});
			}

			// Return user info
			const userData: UserData = {
				id: user.id,
				email: user.email,
				name: user.displayName,
				createdAt: user.createdAt,
				updatedAt: user.updatedAt,
			};

			return this.createSuccessResponse(userData);
		} catch (error) {
			this.logger.error('Error in createOrGetUser', error);
			return this.createErrorResponse(
				'Failed to create or get user',
				500,
			);
		}
	}

	static async createProject(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
		context: RouteContext,
	): Promise<ControllerResponse<ApiResponse<ProjectData>>> {
		try {
			// Validate API key
			if (!(await this.validateApiKey(request, env))) {
				return this.createErrorResponse(
					'Invalid or missing API key',
					401,
				);
			}

			// Parse request body
			const bodyResult = await this.parseJsonBody<{
				userId: string;
				prompt: string;
				language?: string;
				frameworks?: string[];
			}>(request);
			if (!bodyResult.success) {
				return bodyResult.response!;
			}

			const { userId, prompt, language, frameworks } = bodyResult.data!;

			// Validate required fields
			if (!userId || !prompt) {
				return this.createErrorResponse(
					'userId and prompt are required',
					400,
				);
			}

			// Verify user exists
			const userService = new UserService(env);
			const user = await userService.findUser({ id: userId });
			if (!user) {
				return this.createErrorResponse('User not found', 404);
			}

			// Get user config for rate limiting
			const { getUserConfigurableSettings } = await import('../../../config/index');
			const config = await getUserConfigurableSettings(env, userId);

			// Enforce rate limiting
			try {
				await RateLimitService.enforceAppCreationRateLimit(
					env,
					config.security.rateLimit,
					userId,
					request,
				);
			} catch (error) {
				if (error instanceof Error && error.message.includes('Rate limit exceeded')) {
					return this.createErrorResponse(
						'Rate limit exceeded for project creation',
						429,
					);
				}
				throw error;
			}

			// Generate project ID
			const projectId = generateId();

			// Fetch user model configs
			const modelConfigService = new ModelConfigService(env);
			const allModelConfigs =
				await modelConfigService.getUserModelConfigs(userId);
			const userOverrideConfigs = Object.fromEntries(
				Object.entries(allModelConfigs).filter(
					([_, config]) => config.isUserOverride,
				),
			);

			// Build inference context
			const inferenceContext: InferenceContext = {
				userModelConfigs: userOverrideConfigs,
				agentId: projectId,
				userId: userId,
				enableRealtimeCodeFix: true,
			};

			// Get template for query
			const { sandboxSessionId, templateDetails, selection } =
				await getTemplateForQuery(
					env,
					inferenceContext,
					prompt,
					undefined,
					this.logger,
				);

			// Get agent stub
			const agentInstance = await getAgentStub(
				env,
				projectId,
				false,
				this.logger,
			);

			// Initialize agent asynchronously
			const hostname = new URL(request.url).hostname;
			agentInstance.initialize(
				{
					query: prompt,
					language: language || 'typescript',
					frameworks: frameworks || ['react', 'vite'],
					hostname,
					inferenceContext,
					images: [],
					onBlueprintChunk: () => {}, // No streaming for API
					templateInfo: {
						templateDetails,
						selection,
					},
					sandboxSessionId,
				},
				'deterministic',
			).catch((error) => {
				this.logger.error('Agent initialization failed', {
					projectId,
					error,
				});
			});

			// Return immediately with project info
			const projectData: ProjectData = {
				projectId,
				userId,
				prompt,
				status: 'generating',
				websocketUrl: `wss://${hostname}/api/agent/${projectId}/ws`,
				statusUrl: `https://${hostname}/api/v1/projects/${projectId}/status`,
				createdAt: new Date().toISOString(),
			};

			this.logger.info('Project created via API', {
				projectId,
				userId,
			});

			return this.createSuccessResponse(projectData);
		} catch (error) {
			this.logger.error('Error in createProject', error);
			return this.createErrorResponse('Failed to create project', 500);
		}
	}

	static async getProjectStatus(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<ControllerResponse<ApiResponse<ProjectStatusData>>> {
		try {
			// Validate API key
			if (!(await this.validateApiKey(request, env))) {
				return this.createErrorResponse(
					'Invalid or missing API key',
					401,
				);
			}

			const projectId = context.pathParams.projectId;

			if (!projectId) {
				return this.createErrorResponse('Project ID is required', 400);
			}

			// Get agent state
			let agentState: CodeGenState;
			try {
				agentState = await getAgentState(
					env,
					projectId,
					true,
					this.logger,
				);
			} catch (error) {
				this.logger.warn('Project not found', { projectId, error });
				return this.createErrorResponse('Project not found', 404);
			}

			// Get app from database
			const appService = new AppService(env);
			const app = await appService.getApp(projectId);

			if (!app) {
				this.logger.warn('Project not found in database', { projectId });
				return this.createErrorResponse(
					'Project not found in database',
					404,
				);
			}

			// Get preview URL if sandbox deployed
			let previewInfo = null;
			if (agentState.sandboxInstanceId) {
				try {
					const sandboxClient = getSandboxService(agentState.sessionId);
					const status = await sandboxClient.getInstanceStatus(
						agentState.sandboxInstanceId,
					);

					if (status.success) {
						previewInfo = {
							previewURL: status.previewURL,
							tunnelURL: status.tunnelURL,
							isHealthy: status.isHealthy,
						};
					}
				} catch (error) {
					this.logger.warn('Failed to get sandbox status', {
						projectId,
						sandboxInstanceId: agentState.sandboxInstanceId,
						error,
					});
				}
			}

			// Build status response
			const statusData: ProjectStatusData = {
				projectId,
				userId: app.userId!,
				title: app.title,
				description: app.description || '',
				prompt: app.originalPrompt,
				status: app.status,
				framework: app.framework || 'unknown',
				currentPhase: agentState.currentDevState.toString(),
				isGenerating: agentState.shouldBeGenerating,
				progress: {
					completedPhases: agentState.generatedPhases.length,
					totalFiles: Object.keys(agentState.generatedFilesMap || {})
						.length,
					mvpComplete: agentState.mvpGenerated,
				},
				preview: previewInfo,
				errors: (agentState.clientReportedErrors || []).length,
				createdAt: app.createdAt.toISOString(),
				updatedAt: app.updatedAt.toISOString(),
			};

			return this.createSuccessResponse(statusData);
		} catch (error) {
			this.logger.error('Error in getProjectStatus', error);
			return this.createErrorResponse(
				'Failed to get project status',
				500,
			);
		}
	}
}

// Type definitions
interface UserData {
	id: string;
	email: string;
	name: string;
	createdAt: Date;
	updatedAt: Date;
}

interface ProjectData {
	projectId: string;
	userId: string;
	prompt: string;
	status: string;
	websocketUrl: string;
	statusUrl: string;
	createdAt: string;
}

interface ProjectStatusData {
	projectId: string;
	userId: string;
	title: string;
	description: string;
	prompt: string;
	status: string;
	framework: string;
	currentPhase: string;
	isGenerating: boolean;
	progress: {
		completedPhases: number;
		totalFiles: number;
		mvpComplete: boolean;
	};
	preview: {
		previewURL?: string;
		tunnelURL?: string;
		isHealthy: boolean;
	} | null;
	errors: number;
	createdAt: string;
	updatedAt: string;
}
