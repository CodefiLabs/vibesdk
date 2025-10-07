import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { ProjectController } from '../controllers/project/controller';

export function setupProjectRoutes(app: Hono<AppEnv>): void {
	const userRouter = new Hono<AppEnv>();
	const projectRouter = new Hono<AppEnv>();

	// User routes - API key validation happens in controller
	userRouter.post(
		'/find_or_create',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.createOrGetUser),
	);

	// Project routes - API key validation happens in controller
	projectRouter.post(
		'/create',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.createProject),
	);

	projectRouter.get(
		'/:projectId/status',
		setAuthLevel(AuthConfig.public),
		adaptController(ProjectController, ProjectController.getProjectStatus),
	);

	app.route('/api/v1/user', userRouter);
	app.route('/api/v1/projects', projectRouter);
}
