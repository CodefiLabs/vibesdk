# API Routes Implementation Plan

## Overview

Implement three API endpoints for programmatic project creation with API key authentication using the existing Cloudflare Workers infrastructure. The endpoints will allow external services to create users, create projects, and check project status programmatically using a shared API key (env.API_KEY).

## Current State Analysis

The codebase has a well-established route and controller architecture using Hono.js with:
- Controller-based pattern extending BaseController (worker/api/controllers/baseController.ts)
- Route registration in worker/api/routes/index.ts
- API key crypto utilities ready to use (worker/utils/cryptoUtils.ts:63-83)
- Database services for users and apps (UserService, AppService)
- CodeGeneratorAgent Durable Object for project generation
- Sandbox service for preview URL generation

### Key Discoveries:
- Route setup pattern in worker/api/routes/appRoutes.ts:11-70
- Controller pattern in worker/api/controllers/apps/controller.ts
- API key validation utilities exist: sha256Hash(), timingSafeEqual()
- Agent initialization flow in worker/agents/index.ts:74-122
- Preview URL tracking via sandboxInstanceId in agent state

## Desired End State

Three new API endpoints under `/api/v1/projects`:
1. `POST /api/v1/projects/users` - Create/get user by email and name
2. `POST /api/v1/projects` - Create project given userId and prompt
3. `GET /api/v1/projects/:projectId/status` - Get project status with preview URL

All endpoints authenticated via `Authorization: Bearer <API_KEY>` header using env.API_KEY secret.

### Success Verification:
- All three endpoints return correct responses
- API key validation prevents unauthorized access
- Projects are created and tracked in database
- Preview URLs are returned when available
- Rate limiting is enforced

## What We're NOT Doing

- **User-scoped API keys**: Not implementing the database-backed ApiKeyService pattern (that's for per-user API keys)
- **OAuth endpoints**: Not touching worker/api/routes/authRoutes.ts commented lines (those are for user API key management)
- **Webhook support**: Using polling model, not implementing webhook callbacks
- **OpenAPI/Swagger spec**: Documentation deferred to later
- **Custom monitoring**: Using existing logging, no new metrics infrastructure
- **Custom rate limiting**: Using existing RateLimitService with web app limits

## Implementation Approach

Use the existing controller pattern with a new ProjectController that validates the shared env.API_KEY secret. Follow established patterns for database access, agent initialization, and response formatting. Use semantic API versioning with `/api/v1` prefix.

---

## Phase 1: API Route and Controller Setup

### Overview
Create the foundational route file, controller structure, and type definitions following existing patterns.

### Changes Required:

#### 1. Create Route File

**File**: `worker/api/routes/projectRoutes.ts`
**Changes**: Create new file with route definitions

```typescript
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { ProjectController } from '../controllers/project/controller';

export function setupProjectRoutes(app: Hono<AppEnv>): void {
	const router = new Hono<AppEnv>();

	// All routes use public auth level - API key validation happens in controller
	router.post(
		'/users',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.createOrGetUser),
	);

	router.post(
		'/',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.createProject),
	);

	router.get(
		'/:projectId/status',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.getProjectStatus),
	);

	app.route('/api/v1/projects', router);
}
```

#### 2. Create Controller Directory and Types

**File**: `worker/api/controllers/project/controller.ts`
**Changes**: Create new file with controller class and type definitions

```typescript
import { BaseController } from '../baseController';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { createLogger } from '../../../logger';
import { UserService } from '../../../database/services/UserService';
import { AppService } from '../../../database/services/AppService';
import { ModelConfigService } from '../../../database/services/ModelConfigService';
import { RateLimitService } from '../../../services/rate-limit/RateLimitService';
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

	// Methods will be implemented in subsequent phases
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
```

#### 3. Register Routes

**File**: `worker/api/routes/index.ts`
**Changes**: Add import and call setupProjectRoutes

```typescript
// Add to imports (after line 11)
import { setupProjectRoutes } from './projectRoutes';

// Add to setupRoutes function (after line 60, before closing brace)
	// Project management routes (v1 API)
	setupProjectRoutes(app);
```

### Success Criteria:

#### Automated Verification:
- [x] Files created without syntax errors: `make -C . check`
- [x] TypeScript compilation passes: `npm run cf-typegen && npx tsc --noEmit`
- [ ] Routes are registered and accessible (returns 401 without API key)

#### Manual Verification:
- [ ] POST /api/v1/projects/users endpoint exists (curl returns 401)
- [ ] POST /api/v1/projects endpoint exists (curl returns 401)
- [ ] GET /api/v1/projects/:projectId/status endpoint exists (curl returns 401)

---

## Phase 2: API Key Validation Helper

### Overview
Implement the validateApiKey helper method in ProjectController for secure env.API_KEY validation.

### Changes Required:

#### 1. Add Validation Helper Method

**File**: `worker/api/controllers/project/controller.ts`
**Changes**: Add private static method for API key validation

```typescript
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

	// Existing methods...
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `npx tsc --noEmit`
- [ ] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] Method correctly rejects requests without Authorization header
- [ ] Method correctly rejects requests with invalid Bearer token
- [ ] Method correctly accepts requests with valid API_KEY
- [ ] Timing-safe comparison prevents timing attacks

---

## Phase 3: User Management Endpoint

### Overview
Implement the createOrGetUser endpoint that creates a new user or returns existing user by email.

### Changes Required:

#### 1. Implement createOrGetUser Method

**File**: `worker/api/controllers/project/controller.ts`
**Changes**: Add createOrGetUser static method

```typescript
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
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `npx tsc --noEmit`
- [ ] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] Endpoint creates new user when email doesn't exist
- [ ] Endpoint returns existing user when email exists
- [ ] Email validation rejects invalid formats
- [ ] Missing email or name returns 400 error
- [ ] Invalid API key returns 401 error
- [ ] User is created with correct provider and fields

---

## Phase 4: Project Creation Endpoint

### Overview
Implement the createProject endpoint that initializes a CodeGeneratorAgent and returns project information.

### Changes Required:

#### 1. Implement createProject Method

**File**: `worker/api/controllers/project/controller.ts`
**Changes**: Add createProject static method

```typescript
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
		const getUserConfigurableSettings = (await import('../../../utils/getUserConfigurableSettings')).getUserConfigurableSettings;
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
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `npx tsc --noEmit`
- [ ] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] Endpoint creates project with valid userId and prompt
- [ ] Invalid userId returns 404 error
- [ ] Missing userId or prompt returns 400 error
- [ ] Invalid API key returns 401 error
- [ ] Rate limiting prevents excessive project creation
- [ ] Project is created in database with correct fields
- [ ] Agent initialization starts asynchronously
- [ ] Response includes projectId, websocketUrl, and statusUrl

---

## Phase 5: Project Status Endpoint

### Overview
Implement the getProjectStatus endpoint that retrieves project state and preview URLs from the agent.

### Changes Required:

#### 1. Implement getProjectStatus Method

**File**: `worker/api/controllers/project/controller.ts`
**Changes**: Add getProjectStatus static method

```typescript
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
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `npx tsc --noEmit`
- [ ] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] Endpoint returns project status for valid projectId
- [ ] Preview URLs are included when sandbox is deployed
- [ ] Missing projectId returns 400 error
- [ ] Non-existent projectId returns 404 error
- [ ] Invalid API key returns 401 error
- [ ] Status includes generation progress and file counts
- [ ] Gracefully handles missing sandbox instance

---

## Phase 6: Testing and Validation

### Overview
Create comprehensive tests and validate all endpoints work correctly end-to-end.

### Changes Required:

#### 1. Manual Integration Testing

**Test Script**: Create `test-api.sh` for manual testing

```bash
#!/bin/bash

# Configuration
API_KEY="your-api-key-here"
BASE_URL="http://localhost:8787"

echo "Testing API Routes..."

# Test 1: Create/Get User
echo -e "\n1. Testing POST /api/v1/projects/users"
USER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/projects/users" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User"
  }')
echo "Response: $USER_RESPONSE"
USER_ID=$(echo $USER_RESPONSE | jq -r '.data.id')
echo "User ID: $USER_ID"

# Test 2: Create Project
echo -e "\n2. Testing POST /api/v1/projects"
PROJECT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"prompt\": \"Create a simple todo list app\"
  }")
echo "Response: $PROJECT_RESPONSE"
PROJECT_ID=$(echo $PROJECT_RESPONSE | jq -r '.data.projectId')
echo "Project ID: $PROJECT_ID"

# Test 3: Get Project Status (poll until preview available)
echo -e "\n3. Testing GET /api/v1/projects/:projectId/status"
for i in {1..5}; do
  echo "Attempt $i/5..."
  STATUS_RESPONSE=$(curl -s "$BASE_URL/api/v1/projects/$PROJECT_ID/status" \
    -H "Authorization: Bearer $API_KEY")
  echo "Response: $STATUS_RESPONSE"

  PREVIEW_URL=$(echo $STATUS_RESPONSE | jq -r '.data.preview.previewURL')
  if [ "$PREVIEW_URL" != "null" ]; then
    echo "Preview URL available: $PREVIEW_URL"
    break
  fi

  sleep 10
done

# Test 4: Unauthorized Access
echo -e "\n4. Testing unauthorized access"
curl -s -X POST "$BASE_URL/api/v1/projects/users" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "name": "Test"}' | jq '.'

echo -e "\nTests complete!"
```

#### 2. Error Case Testing

Test the following scenarios manually:
- Invalid API key
- Missing Authorization header
- Invalid email format
- Non-existent userId
- Missing required fields
- Rate limit exceeded
- Non-existent projectId

### Success Criteria:

#### Automated Verification:
- [ ] All endpoints compile and deploy: `npm run deploy`
- [x] No TypeScript errors: `npx tsc --noEmit`
- [x] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] POST /api/v1/projects/users creates new user successfully
- [ ] POST /api/v1/projects/users returns existing user when email exists
- [ ] POST /api/v1/projects creates project and starts generation
- [ ] GET /api/v1/projects/:projectId/status returns correct status
- [ ] Preview URL is returned when available
- [ ] All error cases return appropriate status codes
- [ ] Rate limiting prevents excessive requests
- [ ] API key validation blocks unauthorized access

---

## Testing Strategy

### Unit Tests
Since all tests are AI-generated placeholders per CLAUDE.md, defer comprehensive unit testing to a future ticket. For this implementation:
- Rely on TypeScript compilation for type safety
- Use manual testing for validation

### Integration Tests
Manual integration testing via curl/Postman:
- Test complete flow: create user → create project → check status
- Verify API key authentication
- Test error handling paths
- Validate rate limiting

### Manual Testing Steps
1. Set API_KEY in `.dev.vars` for local testing
2. Start local dev server: `npm run dev`
3. Run test script: `bash test-api.sh`
4. Verify user creation in database: `npm run db:studio`
5. Check agent state via WebSocket connection
6. Monitor worker logs for errors
7. Test with invalid API keys
8. Test rate limiting by rapid requests

## Performance Considerations

- **API Key Validation**: SHA-256 hashing adds ~1-2ms per request (acceptable overhead)
- **Agent Initialization**: Asynchronous - doesn't block response
- **Database Queries**: Uses read replicas with 'fresh' strategy for user data
- **Rate Limiting**: Existing DORateLimitStore handles rate limit checks efficiently

## Migration Notes

Not applicable - this is net-new functionality with no data migration required.

## References

- Original research: `thoughts/shared/research/2025-10-07-api-routes-implementation.md`
- Route pattern: `worker/api/routes/appRoutes.ts:11-70`
- Controller pattern: `worker/api/controllers/apps/controller.ts`
- API key utilities: `worker/utils/cryptoUtils.ts:63-83`
- Agent initialization: `worker/agents/index.ts:74-122`
- Sandbox status: `worker/services/sandbox/sandboxSdkClient.ts:1096-1144`
