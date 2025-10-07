# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is an official Cloudflare product - a React+Vite frontend with Cloudflare Workers backend that features a Durable Object-based AI agent capable of building webapps phase-wise from user prompts.

**Important Context:**
- Core functionality: AI-powered webapp generation via Durable Objects
- Authentication system and database schemas are currently under development (existing code is AI-generated and needs review/rewrite)
- Full Cloudflare stack: Workers, D1, Durable Objects, R2 (planned)
- All tests in the project are AI-generated and need replacement

## Development Commands

### Frontend Development
```bash
npm run dev              # Start Vite dev server with hot reload
npm run build            # Build production frontend
npm run lint             # Run ESLint
npm run preview          # Preview production build
```

### Worker Development
```bash
npm run dev              # Run full-stack dev (Vite + local worker via wrangler)
npm run cf-typegen       # Generate TypeScript types for CF bindings
npm run deploy           # Deploy to Cloudflare Workers (includes remote DB migration)
```

### Database (D1) - Under Development
```bash
npm run db:setup         # Initial database setup
npm run db:generate      # Generate migrations (local)
npm run db:migrate:local # Apply migrations locally
npm run db:migrate:remote # Apply migrations to production
npm run db:studio        # Open Drizzle Studio for local DB
```

### Testing - Needs Rewrite
```bash
npm run test             # Run Vitest tests (uses @cloudflare/vitest-pool-workers)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Generate test coverage report
```

Note: Tests use Vitest with `@cloudflare/vitest-pool-workers` for Durable Object testing.

## Core Architecture: AI Code Generation

### Phase-wise Generation System (`worker/agents/core/`)
The heart of the system is the `CodeGeneratorAgent` Durable Object that implements sophisticated code generation:

1. **Blueprint Phase**: Analyzes user requirements and creates project blueprint
2. **Incremental Generation**: Generates code phase-by-phase with specific files per phase
3. **SCOF Protocol**: Structured Code Output Format for streaming generated code
4. **Review Cycles**: Multiple automated review passes including:
   - Static analysis (linting, type checking)
   - Runtime validation via Sandbox Service
   - AI-powered error detection and fixes
5. **Diff Support**: Efficient file updates using unified diff format

### Key Components
- **Durable Object**: `worker/agents/core/smartGeneratorAgent.ts` → `simpleGeneratorAgent.ts` - Stateful code generation
- **Agent Modes**: Supports both 'deterministic' (state machine) and 'smart' (LLM orchestrator) modes
- **State Management**: `worker/agents/core/state.ts` - Generation state tracking
- **WebSocket Protocol**: `worker/agents/core/websocket.ts` - Real-time streaming of generation progress
- **Sandbox Service**: Cloudflare Containers for isolated code execution and validation

### Frontend-Worker Communication
- **Initial Request**: POST `/api/agent`
- **WebSocket Connection**: `/api/agent/:agentId/ws` for real-time updates
- **Message Types**: Typed protocol for file updates, errors, phase transitions

## Areas Under Development

### Authentication System (Needs Review/Rewrite)
Current implementation in `worker/auth/` and `worker/api/controllers/authController.ts`:
- OAuth providers (Google, GitHub) - needs production hardening
- JWT session management - requires security review
- Database schema for users/sessions - needs optimization

### Database Architecture (In Progress)
- Currently using Drizzle ORM with D1
- Schema in `worker/database/schema.ts` - under active development
- Migration system needs refinement

### Testing Strategy (Needs Implementation)
- All current tests are AI-generated placeholders
- Need proper unit tests for core generation logic
- Integration tests for Durable Objects
- E2E tests for generation workflow

## Working with the Codebase

### Adding Features to Code Generation
1. Modify agent logic in `worker/agents/core/simpleGeneratorAgent.ts`
2. Update state types in `worker/agents/core/state.ts`
3. Add new message types for WebSocket protocol in `worker/agents/core/websocket.ts`
4. Update frontend handler in `src/routes/chat/hooks/use-chat.ts`

### Cloudflare-Specific Patterns
- **Durable Objects**: Used for stateful, long-running operations (CodeGeneratorAgent, UserAppSandboxService, DORateLimitStore)
- **D1 Database**: SQLite-based, use batch operations for performance
- **Environment Bindings**: Access via `env` parameter (AI, DB, CodeGenObject, Sandbox, DISPATCHER)
- **Containers**: Sandboxed app execution via `UserAppSandboxService` (defined in `worker/services/sandbox/`)
- **Dispatch Namespaces**: User apps deployed to `env.DISPATCHER` for production serving
- **Domain Routing**: Main platform domain vs. subdomain routing handled in `worker/index.ts`

### Environment Variables
Required in `.dev.vars` for local development:
- `JWT_SECRET` - For session management (under development)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY` - AI providers
- `RUNNER_SERVICE_API_KEY` - For code execution service
- OAuth credentials (being redesigned)

## Important Notes
- Focus on core AI generation functionality when making changes
- Prioritize Cloudflare-native solutions (D1, Durable Objects, R2)
- Always **strictly** follow DRY principles
- Keep code quality high and maintainability in mind
- Always research and understand the codebase before making changes
- Never use 'any' type. If you see 'any', Find the proper appropriate type in the project and then replace it. If nothing is found, then write a type for it. 
- Never use dynamic imports. If you see dynamic imports, Correct it!
- Implement everything the 'right' and 'correct' way instead of 'fast' and 'quick'.
- Don't add comments for explaining your changes to me. Comments should be professional, to the point and should be there to explain the code, not your changes
- Don't start writing new 'corrected' versions of files instead of working on fixing the existing ones

## Common Tasks

### Debugging Code Generation
1. Monitor Durable Object logs: `npm run dev` (watch worker logs in terminal)
2. Check WebSocket messages in browser DevTools (Network → WS tab)
3. Verify Sandbox Service connectivity (check container logs)
4. Review generation state in `CodeGeneratorAgent` via DO storage inspector

### Working with Durable Objects
- **CodeGeneratorAgent**: `worker/agents/core/smartGeneratorAgent.ts` → binding `env.CodeGenObject`
- **UserAppSandboxService**: `worker/services/sandbox/sandboxSdkClient.ts` → binding `env.Sandbox`
- **DORateLimitStore**: `worker/services/rate-limit/DORateLimitStore.ts` → binding `env.DORateLimitStore`
- ID Generation: Based on session/user context
- State Persistence: Automatic via Cloudflare (uses SQLite storage)

### Sandbox Service Integration
- Executes generated code in isolated Cloudflare Container environment
- Provides runtime error feedback via WebSocket
- Returns preview URLs on subdomains (e.g., `appname.build.cloudflare.dev`)
- Configuration: `wrangler.jsonc` containers section
- Instance types: `lite`, `standard-1` through `standard-4` (configurable via `SANDBOX_INSTANCE_TYPE`)
- Routing: Domain-based routing in `worker/index.ts` handles main vs. subdomain requests