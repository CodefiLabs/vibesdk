---
date: 2025-10-07T19:55:21+0000
researcher: Claude Code
git_commit: 94bfede323d2d08671aec2ccfb9fe7f5ad0a5d18
branch: api
repository: vibesdk
topic: 'API Routes Implementation for User and Project Management'
tags: [research, codebase, api, authentication, database, durable-objects]
status: complete
last_updated: 2025-10-07
last_updated_by: Claude Code
---

# Research: API Routes Implementation for User and Project Management

**Date**: 2025-10-07T19:55:21+0000
**Researcher**: Claude Code
**Git Commit**: 94bfede323d2d08671aec2ccfb9fe7f5ad0a5d18
**Branch**: api
**Repository**: vibesdk

## Research Question

How to implement three API routes:

1. Create/get user by email and name (with API_KEY authentication from Cloudflare secrets)
2. Create a new project given user_id and prompt
3. Get project status with preview URL given project_id

## Summary

The codebase uses **Hono.js** with a controller-based architecture, **Drizzle ORM** with **D1 database**, and **Durable Objects** for stateful code generation. The authentication system supports JWT tokens and has infrastructure for API key authentication (currently disabled but ready to enable). Projects are managed through the `CodeGeneratorAgent` Durable Object, which maintains state and generates preview URLs via the Sandbox Service (Cloudflare Containers).

**Key Finding**: API key authentication infrastructure exists but is disabled. Routes can be implemented following existing patterns with API key auth enabled via middleware.

## Detailed Findings

### 1. API Route Architecture

#### Route Organization (`worker/api/routes/`)

The codebase uses a structured route registration system:

- **Entry Point**: `worker/index.ts:110-159` - Domain-based routing with ASSETS binding for static files
- **App Creation**: `worker/app.ts:14-96` - Hono app setup with middleware stack
- **Route Registration**: `worker/api/routes/index.ts:17-61` - Central `setupRoutes()` function

**Middleware Stack Order**:

1. Secure headers (skip for WebSocket)
2. CORS for `/api/*` routes
3. CSRF protection using double-submit cookie pattern
4. Global config and rate limiting
5. Default auth level: `AuthConfig.ownerOnly`

**Standard Route File Pattern** (`worker/api/routes/appRoutes.ts:11-70`):

```typescript
export function setupAppRoutes(app: Hono<AppEnv>): void {
	const appRouter = new Hono<AppEnv>();

	appRouter.get(
		'/',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(AppController, AppController.getUserApps),
	);

	app.route('/api/apps', appRouter);
}
```

#### Controller Pattern (`worker/api/controllers/baseController.ts`)

All controllers extend `BaseController` which provides:

- `parseJsonBody<T>()` - JSON parsing with error handling (line 45-56)
- `createSuccessResponse<T>()` - Type-safe success responses (line 95-99)
- `createErrorResponse<T>()` - Type-safe error responses (line 104-107)
- `executeWithErrorHandling()` - Consistent error wrapping (line 69-75)

**Controller Method Signature**:

```typescript
static async methodName(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    context: RouteContext
): Promise<ControllerResponse<ApiResponse<DataType>>>
```

**RouteContext** contains:

- `user` - Authenticated user (null for public)
- `sessionId` - Session identifier
- `config` - User configuration settings
- `pathParams` - Route parameters
- `queryParams` - Query parameters

#### Hono Adapter (`worker/api/honoAdapter.ts:18-43`)

Bridges Hono context to controller signature:

1. Enforces auth requirements
2. Builds RouteContext from Hono context
3. Calls controller method with standardized parameters

### 2. Database Schema

#### Users Table (`worker/database/schema.ts:16-59`)

```typescript
{
  id: string (primary key, UUID)
  email: string (unique, not null)
  username: string (unique, nullable)
  displayName: string (not null)
  avatarUrl: string
  bio: string
  provider: 'github' | 'google' | 'email'
  providerId: string (not null)
  emailVerified: boolean (default false)
  passwordHash: string (for email provider)
  isActive: boolean
  isSuspended: boolean
  deletedAt: Date (soft delete)
  createdAt: Date
  updatedAt: Date
}
```

**Service Methods** (`worker/database/services/UserService.ts`):

- `createUser(userData)` - Insert new user (line 20-26)
- `findUser({ id?, email?, provider? })` - Flexible lookup (line 31-56)
- `updateUser(userId, updates)` - Update user fields (line 61-67)

#### Apps Table (`worker/database/schema.ts:133-193`)

```typescript
{
  id: string (primary key, same as agentId)
  userId: string (FK to users.id, nullable for anonymous)
  sessionToken: string (for anonymous tracking)
  title: string
  description: string
  originalPrompt: string (user's query)
  finalPrompt: string
  framework: string ('react', 'vue', 'svelte', etc.)
  status: 'generating' | 'completed'
  visibility: 'private' | 'public' (default: private)
  deploymentId: string (extracted from deployment URL)
  lastDeployedAt: Date
  screenshotUrl: string
  screenshotCapturedAt: Date
  version: number
  parentAppId: string (for forks)
  isArchived: boolean
  isFeatured: boolean
  createdAt: Date
  updatedAt: Date
}
```

**Service Methods** (`worker/database/services/AppService.ts`):

- `createApp(appData)` - Insert new app (line 52-59)
- `getApp(appId)` - Retrieve by ID (line 64-73)
- `getUserApps(userId)` - Get user's apps (line 287-356)
- `updateApp(appId, updates)` - Update app fields (line 145-166)

#### Drizzle ORM Configuration

- **Config Files**: `drizzle.config.local.ts`, `drizzle.config.remote.ts`
- **Dialect**: SQLite (D1)
- **Schema Location**: `worker/database/schema.ts`
- **Migrations**: `./migrations`

**Database Service** (`worker/database/database.ts:34-44`):

```typescript
constructor(env: Env) {
    const instrumented = Sentry.instrumentD1WithSentry(env.DB);
    this.d1 = instrumented;
    this.db = drizzle(instrumented, { schema });
    this.enableReplicas = env.ENABLE_READ_REPLICAS === 'true';
}
```

**Read Replica Strategy**:

- `'fast'` - Routes to any replica for lowest latency (public data)
- `'fresh'` - Routes first query to primary for latest data (user-specific)

### 3. Authentication System

#### JWT Authentication (`worker/middleware/auth/`)

**Token Extraction Priority** (`worker/utils/authUtils.ts:44-98`):

1. Authorization header: `Bearer <token>`
2. Cookies: `accessToken`, `auth_token`, `jwt`
3. Query parameters: `token`, `access_token` (for WebSocket)

**JWT Structure** (`worker/types/auth-types.ts:42-58`):

```typescript
{
  sub: userId,
  email: string,
  type: 'access' | 'refresh',
  sessionId: string,
  ipHash: string,
  iat: number,
  exp: number
}
```

**JWTUtils** (`worker/utils/jwtUtils.ts`):

- Uses `jose` library with HS256 algorithm
- Secret from `env.JWT_SECRET`
- Token creation at line 110-124
- Verification at line 83-108

#### API Key Authentication (Infrastructure Exists, Currently Disabled)

**Database Schema** (`worker/database/schema.ts:98-124`):

```typescript
{
  id: string (primary key)
  userId: string (FK)
  name: string (user-friendly identifier)
  keyHash: string (SHA-256 hash, unique)
  keyPreview: string (first 8 + "..." + last 4 chars)
  scopes: string (JSON array)
  isActive: boolean
  lastUsed: Date
  requestCount: number
  expiresAt: Date (optional)
  createdAt: Date
  updatedAt: Date
}
```

**Crypto Utilities** (`worker/utils/cryptoUtils.ts:63-83`):

- `generateApiKey()` - Generates key, hash, and preview (line 63-74)
- `verifyApiKey(key, hash)` - Timing-safe comparison (line 76-83)

**Service Layer** (`worker/database/services/ApiKeyService.ts`):

- `createApiKey()` - Store new key (line 64-87)
- `findApiKeyByHash()` - Lookup active key (line 119-137)
- `updateApiKeyLastUsed()` - Track usage (line 142-154)
- `revokeApiKey()` - Mark inactive (line 92-114)

**Current Status**:

- Routes **DISABLED** in `worker/api/routes/authRoutes.ts:35-38` (commented out)
- Controller methods **EXIST** in `worker/api/controllers/auth/controller.ts:492-529`
- Infrastructure is **PRODUCTION-READY**

#### Route Protection (`worker/middleware/auth/routeAuth.ts`)

**Auth Levels** (line 23):

- `'public'` - No authentication required
- `'authenticated'` - Valid user session required
- `'owner-only'` - User owns the resource + ownership check

**AuthConfig Presets** (line 37-61):

```typescript
{
  public: { required: false, level: 'public' },
  authenticated: { required: true, level: 'authenticated' },
  ownerOnly: {
    required: true,
    level: 'owner-only',
    resourceOwnershipCheck: checkAppOwnership
  }
}
```

**Enforcement Flow** (`enforceAuthRequirement()` at line 138-179):

1. Check if user already in context
2. Call `authMiddleware()` for authenticated/owner-only routes
3. Validate JWT token → create session
4. Perform ownership checks if required
5. Set user rate limits from config
6. Return 401/403 on failure

#### Environment Secrets Access

**Secret Types** (`worker-configuration.d.ts:4-56`):

- **AI Providers**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY`
- **Auth**: `JWT_SECRET`, `SECRETS_ENCRYPTION_KEY`
- **OAuth**: `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`
- **Infrastructure**: `SANDBOX_SERVICE_API_KEY`, `CLOUDFLARE_API_TOKEN`

All accessed via `env` parameter: `env.JWT_SECRET`, `env.API_KEY`, etc.

### 4. Project Creation Flow

#### Entry Point (`worker/api/routes/codegenRoutes.ts:16`)

```typescript
app.post(
	'/api/agent',
	setAuthLevel(AuthConfig.authenticated),
	adaptController(
		CodingAgentController,
		CodingAgentController.startCodeGeneration,
	),
);
```

#### Controller Flow (`worker/api/controllers/agent/controller.ts:33-158`)

**Request Body** (`CodeGenArgs`):

```typescript
{
  query: string (required),
  language?: string (default: 'typescript'),
  frameworks?: string[] (default: ['react', 'vite']),
  selectedTemplate?: string (default: 'auto'),
  agentMode?: 'deterministic' | 'smart' (default: 'deterministic'),
  images?: string[]
}
```

**Steps**:

1. **Parse & Validate** (line 42-50) - Check required `query` field
2. **Rate Limit** (line 65-73) - `RateLimitService.enforceAppCreationRateLimit()`
3. **Generate Agent ID** (line 75) - `crypto.randomUUID()` (used for both DO and DB)
4. **Fetch Model Configs** (line 76-108) - User-specific AI model overrides
5. **Select Template** (line 110-113) - AI-powered template selection
6. **Get Durable Object Stub** - `getAgentStub(env, agentId, false)`
7. **Initialize Agent** (line 126-143) - Pass prompt, template, config
8. **Stream Response** (line 115-158) - NDJSON stream with agent info

**Response Structure**:

```typescript
{
  message: 'Code generation started',
  agentId: string,
  websocketUrl: string, // ws://host/api/agent/{agentId}/ws
  httpStatusUrl: string, // /api/agent/{agentId}
  template: { name, files }
}
```

#### Durable Object Instantiation (`worker/agents/index.ts:15-42`)

**`getAgentStub()` Function**:

- Uses `getAgentByName()` from `agents` npm package
- Binding: `env.CodeGenObject` (configured in `wrangler.jsonc:85`)
- Agent ID as Durable Object name
- For reconnecting: searches jurisdictions (undefined, 'eu')
- For new: creates with `locationHint: 'enam'`

**Configuration** (`wrangler.jsonc:81-86`):

```jsonc
{
	"class_name": "CodeGeneratorAgent",
	"name": "CodeGenObject",
}
```

#### Agent Initialization (`worker/agents/core/simpleGeneratorAgent.ts:273-339`)

**`initialize()` Method**:

1. **Generate Blueprint** (line 283-299) - AI creates project structure
2. **Stream Blueprint Chunks** - Via `onBlueprintChunk` callback
3. **Initialize State** (line 304-316) - Store all metadata
4. **Parallel Operations** (line 318-335):
    - Deploy to Sandbox
    - Generate setup commands
    - Generate README
5. **Execute Commands** (line 322)
6. **Save to Database** (line 243-267)

**Database Persistence** (`saveToDatabase()` at line 243-267):

```typescript
await appService.createApp({
	id: agentId, // Same as Durable Object ID
	userId: inferenceContext.userId,
	sessionToken: null,
	title: blueprint.projectName || query.substring(0, 50),
	description: blueprint.description,
	originalPrompt: query,
	finalPrompt: query,
	framework: blueprint.frameworks[0],
	visibility: 'private',
	status: 'generating',
	createdAt: new Date(),
	updatedAt: new Date(),
});
```

#### Template Selection (`worker/agents/index.ts:74-122`)

**`getTemplateForQuery()` Flow**:

1. Fetch available templates from Sandbox Service
2. Generate sandbox session ID
3. Run AI-powered template selection in parallel
4. Fetch full template details including files
5. Return: `sandboxSessionId`, `templateDetails`, `selection` metadata

### 5. Project Status Tracking

#### State Structure (`worker/agents/core/state.ts:32-62`)

**CodeGenState Interface**:

```typescript
{
  // Status
  currentDevState: CurrentDevState, // IDLE, GENERATING, REVIEWING, etc.
  shouldBeGenerating: boolean,
  mvpGenerated: boolean,

  // Generation Progress
  generatedPhases: PhaseState[],
  generatedFilesMap: Record<string, FileState>,
  phasesCounter: number,

  // Deployment
  sandboxInstanceId?: string,
  sessionId: string,

  // Metadata
  query: string,
  blueprint: Blueprint,
  templateDetails: TemplateDetails,
  inferenceContext: InferenceContext,

  // Errors
  clientReportedErrors: ClientReportedErrorType[]
}
```

**State Persistence** (`node_modules/agents/src/index.ts:700-714`):

- Stored in SQLite: `cf_agents_state` table
- JSON serialized
- Survives Durable Object hibernation
- Broadcasts to WebSocket connections on every update

#### Preview URL Generation

**Sandbox Instance Creation** (`worker/agents/core/simpleGeneratorAgent.ts:1693-1724`):

1. Generate project name: `v1-{prefix}-{uniqueId}`
2. Create webhook URL for runtime errors
3. Call `sandboxServiceClient.createInstance()`
4. Cache preview URL

**Sandbox Service Setup** (`worker/services/sandbox/sandboxSdkClient.ts:846-917`):

1. **Port Allocation** (line 210-237) - Find available port 8001-8999
2. **Template Bootstrap** - Extract from R2
3. **Dev Server Startup** - Execute `npm run dev`
4. **Preview Exposure**:
    - `PREVIEW_MODE === 'cloudflare'`: `https://{app}.{subdomain}.workers.dev`
    - `PREVIEW_MODE === 'tunnel'`: `https://{id}.trycloudflare.com`
    - Custom domain: `https://{app}.preview.{CUSTOM_DOMAIN}`

**Instance Metadata** (`worker/services/sandbox/sandboxSdkClient.ts:56-67`):

```typescript
{
  templateName: string,
  projectName: string,
  startTime: string,
  webhookUrl?: string,
  previewURL?: string,
  tunnelURL?: string,
  processId?: string,
  allocatedPort?: number,
  donttouch_files: string[],
  redacted_files: string[]
}
```

#### Status Query Methods

**HTTP Endpoint** (`worker/api/routes/codegenRoutes.ts:19`):

```typescript
app.get(
	'/api/agent/:agentId',
	setAuthLevel(AuthConfig.ownerOnly),
	adaptController(
		CodingAgentController,
		CodingAgentController.connectToExistingAgent,
	),
);
```

**Returns**:

```typescript
{
  websocketUrl: string,
  agentId: string
}
```

**Direct State Access** (`worker/agents/index.ts:44-47`):

```typescript
export async function getAgentState(
	env: Env,
	agentId: string,
	searchInOtherJurisdictions: boolean = false,
): Promise<CodeGenState>;
```

**Sandbox Status** (`worker/services/sandbox/sandboxSdkClient.ts:1096-1144`):

```typescript
async getInstanceStatus(instanceId: string): Promise<{
  success: boolean,
  isHealthy: boolean,
  previewURL?: string,
  tunnelURL?: string,
  processId?: string
}>
```

#### WebSocket Protocol (`worker/api/websocketTypes.ts`)

**Key Message Types**:

1. `cf_agent_state` - Full state update (line 14-16)
2. `deployment_completed` - Preview ready with URLs (line 75-81)
3. `generation_complete` - Generation finished (line 58-62)
4. `phase_generated` - Phase completed (line 134-141)
5. `runtime_error_found` - Preview errors (line 103-107)

**Broadcasting** (`worker/agents/core/websocket.ts:251-260`):

```typescript
broadcastToConnections(agent, type, data);
```

- Sends to all connected WebSocket clients
- Automatic on every `setState()` call

## Code References

### Route Organization

- `worker/index.ts:110-159` - Main worker fetch handler
- `worker/app.ts:14-96` - Hono app creation with middleware
- `worker/api/routes/index.ts:17-61` - Route registration
- `worker/api/honoAdapter.ts:18-43` - Controller adapter

### Database

- `worker/database/schema.ts:16-59` - Users table
- `worker/database/schema.ts:133-193` - Apps table
- `worker/database/schema.ts:98-124` - API keys table
- `worker/database/services/UserService.ts:20-56` - User CRUD
- `worker/database/services/AppService.ts:52-73` - App CRUD
- `worker/database/database.ts:34-65` - DB service & replica strategy

### Authentication

- `worker/middleware/auth/auth.ts:15-54` - Token validation
- `worker/middleware/auth/routeAuth.ts:37-186` - Route protection
- `worker/utils/jwtUtils.ts:83-124` - JWT creation/verification
- `worker/utils/cryptoUtils.ts:63-83` - API key generation/verification
- `worker/database/services/ApiKeyService.ts:38-154` - API key management

### Project Creation

- `worker/api/controllers/agent/controller.ts:33-158` - Generation controller
- `worker/agents/index.ts:15-122` - Agent instantiation & template selection
- `worker/agents/core/simpleGeneratorAgent.ts:273-339` - Agent initialization
- `worker/agents/core/simpleGeneratorAgent.ts:243-267` - Database persistence

### Status Tracking

- `worker/agents/core/state.ts:32-62` - State structure
- `worker/services/sandbox/sandboxSdkClient.ts:846-1144` - Sandbox management
- `worker/agents/core/websocket.ts:251-260` - WebSocket broadcasting
- `worker/api/websocketTypes.ts` - Message type definitions

## Architecture Insights

### Durable Objects as State Machines

The CodeGeneratorAgent uses Durable Objects with built-in SQLite storage for persistent state. The agent ID serves as:

- Durable Object name/ID
- Database primary key (apps.id)
- WebSocket routing parameter
- Sandbox session correlation key

This universal identifier pattern eliminates the need for complex ID mapping.

### Service Layer Pattern

All database operations are encapsulated in service classes extending `BaseService`:

- Clean separation between domain logic and data access
- Consistent error handling via `handleDatabaseError()`
- Read replica optimization with `'fast'` vs `'fresh'` strategies

### Middleware-Based Security

Authentication is enforced at multiple levels:

1. **Global**: Default `AuthConfig.ownerOnly` on all `/api/*` routes
2. **Route-Level**: Override with `setAuthLevel()`
3. **Controller**: Access user via `context.user`
4. **Resource**: Ownership checks via `checkAppOwnership()`

### Streaming Architecture

Multiple streaming layers enable real-time updates:

- **HTTP Streaming**: SSE content-type for initial response
- **Blueprint Streaming**: Callbacks during generation
- **WebSocket**: Real-time file updates and state changes

### Read Replica Optimization

Strategic use of D1 Sessions API:

- **Public data**: `'fast'` strategy routes to nearest replica
- **User data**: `'fresh'` strategy ensures consistency via primary
- Configured via `ENABLE_READ_REPLICAS` environment variable

## Implementation Patterns

### Pattern 1: Create Route File

**Location**: `/worker/api/routes/projectRoutes.ts`

```typescript
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { ProjectController } from '../controllers/project/controller';

export function setupProjectRoutes(app: Hono<AppEnv>): void {
	const router = new Hono<AppEnv>();

	// Create/get user (API key auth)
	router.post(
		'/users',
		setAuthLevel(AuthConfig.public), // Custom API key validation in controller
		adaptController(ProjectController, ProjectController.createOrGetUser),
	);

	// Create project (API key auth)
	router.post(
		'/',
		setAuthLevel(AuthConfig.public), // Custom API key validation
		adaptController(ProjectController, ProjectController.createProject),
	);

	// Get project status (API key auth)
	router.get(
		'/:projectId/status',
		setAuthLevel(AuthConfig.public), // Custom API key validation
		adaptController(ProjectController, ProjectController.getProjectStatus),
	);

	app.route('/api/projects', router);
}
```

### Pattern 2: Create Controller

**Location**: `/worker/api/controllers/project/controller.ts`

```typescript
import { BaseController } from '../baseController';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { createLogger } from '../../../logger';
import { UserService } from '../../../database/services/UserService';
import { verifyApiKey } from '../../../utils/cryptoUtils';
import { sha256Hash } from '../../../utils/cryptoUtils';
import { ApiKeyService } from '../../../database/services/ApiKeyService';

export class ProjectController extends BaseController {
	static logger = createLogger('ProjectController');

	// Helper: Validate API key from env.API_KEY
	private static async validateApiKey(
		request: Request,
		env: Env,
	): Promise<boolean> {
		const authHeader = request.headers.get('Authorization');
		if (!authHeader?.startsWith('Bearer ')) {
			return false;
		}

		const providedKey = authHeader.substring(7);
		const expectedKey = env.API_KEY;

		if (!expectedKey) {
			this.logger.error('API_KEY not configured in environment');
			return false;
		}

		// Timing-safe comparison
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
					providerId: email.toLowerCase(), // Use email as provider ID
					emailVerified: true,
					isActive: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				});

				this.logger.info('Created new user', {
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
			}>(request);
			if (!bodyResult.success) {
				return bodyResult.response!;
			}

			const { userId, prompt } = bodyResult.data!;

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

			// Generate agent ID (project ID)
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
					prompt,
					[],
					inferenceContext,
					this.logger,
				);

			// Get agent stub
			const agentInstance = await getAgentStub(
				env,
				projectId,
				false,
				this.logger,
			);

			// Initialize agent
			const initPromise = agentInstance.initialize({
				query: prompt,
				language: 'typescript',
				frameworks: ['react', 'vite'],
				hostname: new URL(request.url).hostname,
				inferenceContext,
				images: [],
				onBlueprintChunk: () => {}, // No streaming for API
				templateInfo: {
					...templateDetails,
					selection,
				},
				sandboxSessionId,
				agentMode: 'deterministic',
			});

			// Don't wait for initialization to complete
			// Return immediately with project info

			const projectData: ProjectData = {
				projectId,
				userId,
				prompt,
				status: 'generating',
				websocketUrl: `wss://${new URL(request.url).hostname}/api/agent/${projectId}/ws`,
				statusUrl: `https://${new URL(request.url).hostname}/api/projects/${projectId}/status`,
				createdAt: new Date().toISOString(),
			};

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
				return this.createErrorResponse('Project not found', 404);
			}

			// Get app from database
			const appService = new AppService(env);
			const app = await appService.getApp(projectId);

			if (!app) {
				return this.createErrorResponse(
					'Project not found in database',
					404,
				);
			}

			// Get preview URL if sandbox deployed
			let previewInfo = null;
			if (agentState.sandboxInstanceId) {
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
			}

			// Build status response
			const statusData: ProjectStatusData = {
				projectId,
				userId: app.userId!,
				title: app.title,
				description: app.description,
				prompt: app.originalPrompt,
				status: app.status,
				framework: app.framework,
				currentPhase: agentState.currentDevState,
				isGenerating: agentState.shouldBeGenerating,
				progress: {
					completedPhases: agentState.generatedPhases.length,
					totalFiles: Object.keys(agentState.generatedFilesMap)
						.length,
					mvpComplete: agentState.mvpGenerated,
				},
				preview: previewInfo,
				errors: agentState.clientReportedErrors.length,
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
```

### Pattern 3: Register Routes

**Location**: `/worker/api/routes/index.ts`

Add to `setupRoutes()` function:

```typescript
import { setupProjectRoutes } from './projectRoutes';

export function setupRoutes(app: Hono<AppEnv>): void {
	// ... existing routes ...

	// Project management routes
	setupProjectRoutes(app);
}
```

### Pattern 4: Import Required Functions

Add to controller imports:

```typescript
import {
	getAgentStub,
	getAgentState,
	getTemplateForQuery,
} from '../../agents/index';
import { getSandboxService } from '../../services/sandbox/index';
import { ModelConfigService } from '../../database/services/ModelConfigService';
import { AppService } from '../../database/services/AppService';
import { generateId } from '../../utils/idGenerator';
import type { CodeGenState } from '../../agents/core/state';
import type { InferenceContext } from '../../agents/types/inference-types';
```

## Security Considerations

### API Key Authentication

1. **Environment Secret**: Store API_KEY in Cloudflare secrets dashboard
2. **Timing-Safe Comparison**: Use SHA-256 hash comparison to prevent timing attacks
3. **Bearer Token Format**: Require `Authorization: Bearer <key>` header
4. **Error Messages**: Don't reveal whether key is invalid or missing (use generic 401)

### Rate Limiting

Consider adding rate limiting for API key routes:

```typescript
await RateLimitService.enforceAppCreationRateLimit(
	env,
	config.security.rateLimit,
	userId,
	request,
);
```

### Input Validation

- Validate email format before user creation
- Sanitize user inputs (email, name, prompt)
- Check prompt length limits
- Validate userId exists before project creation

### CORS Configuration

If API will be called from external domains, configure CORS in `worker/app.ts:32`:

```typescript
cors({
	origin: ['https://allowed-domain.com'],
	allowMethods: ['POST', 'GET', 'OPTIONS'],
	allowHeaders: ['Authorization', 'Content-Type'],
});
```

## Testing Recommendations

### Unit Tests

- UserService.createUser() and findUser()
- API key validation logic
- Project creation flow
- Status query with missing project

### Integration Tests

- Full API flow: create user → create project → get status
- API key authentication rejection
- Invalid request body handling
- Rate limiting behavior

### E2E Tests

- Complete project generation lifecycle
- Preview URL accessibility
- WebSocket connection and updates
- Error reporting from sandbox

## Related Research

- Authentication system architecture documented in CLAUDE.md (lines 124-126) notes current implementation needs review
- Database schemas marked as "under development" (CLAUDE.md line 54)
- All tests are AI-generated placeholders requiring replacement (CLAUDE.md line 59)

## Open Questions

1. **API Key Scope**: Should env.API_KEY support multiple keys or be a single shared secret? Single shared key for now is fine, it will only be used by admins at the moment
2. **User Model Configs**: Should API-created users get default model configs? Yes an APi created user should be treated no differently than a user created via the web app.
3. **Project Ownership**: Should API-created projects support transfer to authenticated users? AN API created app should be assigned to a user account just as if they created the project via the web app.
4. **Rate Limits**: What are appropriate rate limits for programmatic API access? This depends on the usage of the API. For now, I think we can just use the same rate limits as the web app.
5. **Webhook Support**: Should status updates support webhook callbacks instead of polling? Not at the moment, for now we will use API polling rather than implementing webhooks
6. **API Versioning**: Should routes include version prefix (e.g., `/api/v1/projects`)? Yes, let's use semantic versioning

## Next Steps

1. **Enable API Key Routes**: Uncomment lines 35-38 in `worker/api/routes/authRoutes.ts`. Check that we really want to do this, These routes might be for creating LLM API keys rather an keys for our own API
2. **Add API_KEY Secret**: Configure in Cloudflare Workers dashboard. I already created this in the dashboard
3. **Implement Project Routes**: Create files following patterns above
4. **Add Tests**: Create comprehensive test suite for new endpoints
5. **Documentation**: Add OpenAPI/Swagger spec for API routes. no need to imlpement this for now
6. **Monitoring**: Add logging and metrics for API usage tracking. no need to implement this for now
