// Preloaded (`node --require`, through NODE_OPTIONS) into the vitest process tree by run-full-suite.mjs. When the wrapper
// is SIGKILLed it cannot sweep the detached vitest process group; this watchdog polls the wrapper PID every 2 s and
// SIGKILLs its own process group (vitest main is the group leader) and itself once the wrapper is gone.
'use strict';

const wrapperPid = Number(process.env.QUOKY_TEST_WRAPPER_PID);
if (Number.isInteger(wrapperPid) && wrapperPid > 0) {
  const intervalMs = Number(process.env.QUOKY_TEST_WATCHDOG_MS) > 0 ? Number(process.env.QUOKY_TEST_WATCHDOG_MS) : 2000;
  const alive = () => {
    try {
      process.kill(wrapperPid, 0);
      return true;
    } catch (error) {
      return Boolean(error) && error.code === 'EPERM';
    }
  };
  const timer = setInterval(() => {
    if (alive()) return;
    try {
      process.kill(-process.pid, 'SIGKILL'); // works for the group leader (vitest main): takes its workers along
    } catch {
      // not a group leader
    }
    process.kill(process.pid, 'SIGKILL');
  }, intervalMs);
  timer.unref();
}
