import * as childProcess from 'node:child_process';
import {
  exec,
  execFile,
  execSync,
  spawn,
} from 'node:child_process';

declare const userCommand: string;
declare const userCode: string;

// ruleid: psfn.security.dynamic-code-execution
eval(userCode);

// ruleid: psfn.security.dynamic-code-execution
new Function(userCode);

// ok: psfn.security.dynamic-code-execution
JSON.parse(userCode);

// ruleid: psfn.security.shell-true
spawn('git', ['status'], { shell: true });

// ok: psfn.security.shell-true
spawn('git', ['status'], { shell: false });

// ruleid: psfn.security.nonliteral-child-process-exec
exec(userCommand);

// ruleid: psfn.security.nonliteral-child-process-exec
execSync(userCommand);

// ruleid: psfn.security.nonliteral-child-process-exec
childProcess.exec(userCommand);

// ruleid: psfn.security.nonliteral-child-process-exec
childProcess.execSync(userCommand);

// ok: psfn.security.nonliteral-child-process-exec
execSync('git status --short');

// ok: psfn.security.nonliteral-child-process-exec
execFile('git', ['status', '--short']);

// ruleid: psfn.security.disabled-tls-verification
const insecureTls = { rejectUnauthorized: false };

// ok: psfn.security.disabled-tls-verification
const verifiedTls = { rejectUnauthorized: true };

// ruleid: psfn.security.disabled-tls-verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

void insecureTls;
void verifiedTls;
