// Подтягивает документацию соседних репозиториев в сайт: каждый репозиторий из
// docs/external-docs.json клонируется в docs/.vitepress/sync, а его каталог
// документации копируется в docs/<target>. Оба каталога не хранятся в git.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const docsDir = path.resolve('docs');
const syncDir = path.join(docsDir, '.vitepress', 'sync');
const entries = JSON.parse(readFileSync(path.join(docsDir, 'external-docs.json'), 'utf8'));

mkdirSync(syncDir, { recursive: true });

for (const { repository, source, target } of entries) {
	const name = repository.split('/').pop();
	const repoDir = path.join(syncDir, name);
	if (existsSync(path.join(repoDir, '.git'))) {
		execSync('git pull --ff-only --quiet', { cwd: repoDir, stdio: 'inherit' });
	} else {
		rmSync(repoDir, { recursive: true, force: true });
		execSync(`git clone --depth 1 --quiet https://github.com/${repository}.git "${repoDir}"`, { stdio: 'inherit' });
	}
	const sourceDir = path.join(repoDir, source);
	if (!existsSync(sourceDir)) {
		throw new Error(`${repository}: каталога ${source} нет`);
	}
	const targetDir = path.join(docsDir, target);
	rmSync(targetDir, { recursive: true, force: true });
	cpSync(sourceDir, targetDir, { recursive: true });
	console.log(`${repository}/${source} -> docs/${target}`);
}
