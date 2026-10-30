import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('Docker log cleanup preserves a bounded tail and never truncates other files or failed archives', async () => {
  const script = `
import importlib.util,pathlib,tempfile,gzip
spec=importlib.util.spec_from_file_location('cleanup','scripts/trim-docker-logs.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
pathlib.Path('.test-tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir='.test-tmp') as directory:
 root=pathlib.Path(directory); logs=root/'logs';logs.mkdir();archive=root/'archives'
 log=logs/('a'*64+'-json.log');log.write_bytes(b'0123456789'*10)
 assert module.trim_log(log,archive,limit=64,tail_bytes=16)==100
 assert log.stat().st_size==0
 assert gzip.open(archive/(log.name+'.tail.gz'),'rb').read()==(b'0123456789'*10)[-16:]
 assert (archive/(log.name+'.tail.gz')).stat().st_mode & 0o777 == 0o600
 log.write_bytes(b'keep');assert module.trim_log(log,archive,limit=64)==0;assert log.read_bytes()==b'keep'
 other=logs/'hub.db';other.write_bytes(b'protected'*20);assert module.trim_log(other,archive,limit=1)==0;assert other.read_bytes()==b'protected'*20
 log.unlink();log.symlink_to(other)
 try:module.trim_log(log,archive,limit=1)
 except OSError:pass
 else:raise AssertionError('symlink must be rejected')
 assert other.read_bytes()==b'protected'*20
 log.unlink();log.write_bytes(b'preserve on failure'*10);bad=root/'not-a-directory';bad.write_text('file')
 try:module.trim_log(log,bad,limit=1)
 except OSError:pass
 else:raise AssertionError('archive failure must abort')
 assert log.read_bytes()==b'preserve on failure'*10
print('safe')
`;
  const { stdout } = await execute('python3', ['-c', script]);
  assert.equal(stdout.trim(), 'safe');
});
