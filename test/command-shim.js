const fs = require('node:fs/promises');
const { join, delimiter } = require('node:path');
const { tmpdir } = require('node:os');

// A real subprocess with controlled protocol output for corrupt/partial tool
// responses and timeouts. Positive media tests also use the actual ffprobe.
exports.commandShim = async (t, command) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-command-fixture-'));
  const originalPath = process.env.PATH;
  await fs.writeFile(join(root, command), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'arguments.json'), JSON.stringify(process.argv.slice(2)));
const response = JSON.parse(fs.readFileSync(path.join(__dirname, 'response.json'), 'utf8'));
const finish = () => { process.stdout.write(response.stdout || ''); process.stderr.write(response.stderr || ''); process.exitCode = response.code || 0; };
if (response.delay) setTimeout(finish, response.delay); else finish();
`, { mode: 0o700 });
  process.env.PATH = root + delimiter + originalPath;
  t.after(async () => { process.env.PATH = originalPath; await fs.rm(root, { recursive: true, force: true }); });
  return {
    configure: (response) => fs.writeFile(join(root, 'response.json'), JSON.stringify(response)),
    arguments: async () => JSON.parse(await fs.readFile(join(root, 'arguments.json'), 'utf8')),
  };
};
