import * as vscode from 'vscode';
import {
	registerProjectsBootstrap,
} from '../features/projects/registerProjectsBootstrap';
import {
	registerProjectsRuntime,
	type RegisterProjectsRuntimeResult,
} from '../features/projects/registerProjectsRuntime';
import { registerWorkspaceProjectsFeature } from '../features/projects/registerWorkspaceProjectsFeature';
import { createShowNot1CProjectMessage } from './projectUi';

export interface ProjectsFlow {
	registerRuntime: (
		onArtifactsExcludeChanged?: () => void
	) => Promise<RegisterProjectsRuntimeResult>;
}

/**
 * Инициализирует flow фичи «1С: Проекты»: проекты рабочей области и bootstrap сразу, runtime по требованию.
 */
export function registerProjectsFlow(
	context: vscode.ExtensionContext
): ProjectsFlow {
	registerWorkspaceProjectsFeature(context, createShowNot1CProjectMessage());
	const bootstrap = registerProjectsBootstrap(context);

	return {
		registerRuntime: (onArtifactsExcludeChanged?: () => void) =>
			registerProjectsRuntime({
				context,
				projectStorage: bootstrap.projectStorage,
				oneCLocator: bootstrap.oneCLocator,
				providers: bootstrap.providers,
				stack: bootstrap.stack,
				projectFilePath: bootstrap.projectFilePath,
				onArtifactsExcludeChanged,
			}),
	};
}
