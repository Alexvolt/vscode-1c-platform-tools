// Сервер по протоколу `md-sparrow serve` для тестов клиента.
//
// Аргументы: режим, путь jar, каталог состояния. Запуски пишутся в starts.log,
// выполненные запросы в exec.log. Запрос: args[0] подкоманда, args[1] поведение.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const [mode, jarPath, stateDir] = process.argv.slice(2);

fs.appendFileSync(path.join(stateDir, 'starts.log'), `${process.pid}\n`);

if (mode === 'unsupported') {
	process.stderr.write("Unmatched argument at index 0: 'serve'\n");
	process.exit(2);
}

const pending = new Map();
let inFlight = 0;
let maxConcurrent = 0;
let early = 0;
let ready = false;
let closing = false;
const seen = [];

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exitWhenIdle() {
	if (closing && inFlight === 0) {
		process.exit(0);
	}
}

function respond(id, exitCode, stdout = '', stderr = '') {
	pending.delete(id);
	inFlight -= 1;
	send({ id, exitCode, stdout, stderr });
	exitWhenIdle();
}

function execute(request) {
	const [command, behaviour, ...rest] = request.args;
	seen.push(behaviour);
	fs.appendFileSync(path.join(stateDir, 'exec.log'), `${command} ${behaviour}\n`);
	inFlight += 1;
	maxConcurrent = Math.max(maxConcurrent, inFlight);
	const { id } = request;
	switch (behaviour) {
		case 'echo':
			setTimeout(() => respond(id, 0, rest[0]), 0);
			return;
		case 'pid':
			setTimeout(() => respond(id, 0, String(process.pid)), 0);
			return;
		case 'cwd':
			setTimeout(() => respond(id, 0, request.cwd ?? ''), 0);
			return;
		case 'fail':
			setTimeout(() => respond(id, 2, '', 'ошибка операции'), 0);
			return;
		case 'sleep': {
			const timer = setTimeout(() => respond(id, 0, rest[1] ?? ''), Number(rest[0]));
			pending.set(id, timer);
			return;
		}
		case 'jar':
			setTimeout(() => respond(id, 0, `${jarPath}\n${fs.readFileSync(jarPath, 'utf8')}`), 0);
			return;
		case 'stats':
			setTimeout(() => respond(id, 0, JSON.stringify({ maxConcurrent, early, seen })), 0);
			return;
		case 'crash-once': {
			const marker = path.join(stateDir, 'crashed');
			if (!fs.existsSync(marker)) {
				fs.writeFileSync(marker, '');
				setTimeout(() => {
					process.stderr.write('java.lang.OutOfMemoryError: Java heap space\n');
					process.exit(3);
				}, Number(rest[0] ?? 0));
				return;
			}
			setTimeout(() => respond(id, 0, 'выжил'), 0);
			return;
		}
		case 'crash':
			process.stderr.write('java.lang.OutOfMemoryError: Java heap space\n');
			process.exit(3);
			return;
		case 'fatal':
			// Сбой JVM: последний ответ помечен closing, процесс выходит чуть позже и до выхода ещё принимает запросы
			setTimeout(() => {
				pending.delete(id);
				inFlight -= 1;
				send({ id, exitCode: 1, stdout: '', stderr: 'java.lang.OutOfMemoryError: Java heap space', closing: true });
				setTimeout(() => process.exit(1), Number(rest[0] ?? 300));
			}, 0);
			return;
		default:
			setTimeout(() => respond(id, 2, '', `неизвестное поведение ${behaviour}`), 0);
	}
}

function onLine(line) {
	if (!ready) {
		early += 1;
	}
	if (/[^\x20-\x7e]/.test(line)) {
		const id = /"id":(\d+)/.exec(line);
		inFlight += 1;
		respond(id ? Number(id[1]) : 0, 2, '', 'в строке запроса есть символы вне ASCII');
		return;
	}
	const message = JSON.parse(line);
	if (message.shutdown) {
		closing = true;
		exitWhenIdle();
		return;
	}
	if (message.cancel) {
		const timer = pending.get(message.id);
		if (timer !== undefined) {
			clearTimeout(timer);
			respond(message.id, 130);
		}
		return;
	}
	if (!Array.isArray(message.args)) {
		inFlight += 1;
		respond(message.id, 2, '', 'нет args');
		return;
	}
	execute(message);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', onLine);
input.on('close', () => {
	closing = true;
	exitWhenIdle();
});

switch (mode) {
	case 'garbage':
		process.stdout.write('Usage: md-sparrow [-hV] [COMMAND]\n');
		break;
	case 'silent':
		break;
	case 'wrong-protocol':
		send({ ready: true, version: '9.9.9', protocol: 99 });
		break;
	case 'slow-ready':
		setTimeout(() => {
			ready = true;
			send({ ready: true, version: '0.0.0-test', protocol: 1 });
		}, 300);
		break;
	default:
		ready = true;
		send({ ready: true, version: '0.0.0-test', protocol: 1 });
}
