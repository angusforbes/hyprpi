// Synthetic providers and host effects only. No model key, public API, browser, sbx policy or GPU worker is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const TASK = 'Perovskite solar cell stability and encapsulation';
export function installFixtures(rig) {
  const P = rig.P;
  const foundPi = spawnSync('/usr/bin/which', ['pi'], { encoding: 'utf8' });
  if (foundPi.status === 0) {
    const pi = fs.realpathSync(foundPi.stdout.trim());
    if (!fs.statSync(pi).isFile()) throw new Error('installed Pi must be a regular executable');
    const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(P('bin/pi'), '#!/bin/sh\nexec ' + q(pi) + ' "$@"\n', { mode: 0o700 });
  }
  fs.writeFileSync(P('bin/bash'), '#!/bin/sh\nif [ "$1" = -lc ]; then shift; exec /bin/bash --noprofile --norc -c "$@"; fi\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
  for (const dir of ['projects/fixture', 'card', 'edits']) fs.mkdirSync(P(dir), { recursive: true });
  fs.writeFileSync(P('projects/fixture/notes.md'), 'Synthetic fixture notes. No real work data.\n');
  fs.writeFileSync(P('card/card.md'), '# Synthetic gateway test\nOnly the fixture project is shared.\n');
  const worlds = P('config/hyprpi/worlds');
  fs.mkdirSync(worlds, { recursive: true });
  const worldFile = path.join(worlds, rig.sandbox + '.json');
  // All world letters in this test belong to the PRIVATE daemon. There is no connection to live world G (or I).
  fs.writeFileSync(worldFile, JSON.stringify({ sandbox: rig.sandbox, world: 'I', workspaces: [81, 82], task: TASK, access: 'safe', gpu: 'off', projects: [], doorman: { mode: 'doorman-safe' } }, null, 2));
  const config = {
    rooms: 'world', follow: false, pi: '/bin/false', piArgs: [], chime: false, cwd: P('ws'),
    projectFolders: [P('projects')], roleFolders: {}, jotExtension: '', terminalCommand: ['/bin/false'],
  };
  fs.writeFileSync(P('config/hyprpi/config.json'), JSON.stringify(config));
  const relay = { log_text: true, sandboxes: [
    { name: rig.sandbox, agent_id: 'sbx-' + rig.sandbox, workspace: P('ws'), inbox: P('inbox'), workspace_num: 81, container: 'gateway-e2e', review_in: rig.doorman, review_room: 'I' },
    { name: rig.doorman, display: 'Fixture Doorman-I', doorman_for: rig.sandbox, reports_to: 'Thoughts-I', host_agents: false, workspace: P('dws'), inbox: P('dinbox'), card: P('card'), workspace_num: 82, visibility: 'developer', review_in: rig.doorman, review_room: 'I', bridge: { tools: ['Read'], folders: [P('projects/fixture')], time_limit_s: 300 } },
  ] };
  fs.writeFileSync(P('config/hyprpi/sbx-relay.json'), JSON.stringify(relay));
  fs.writeFileSync(P('config/hyprpi/research.json'), JSON.stringify({ sandboxes: { [rig.sandbox]: { doorman: rig.doorman, reader: rig.reader || rig.sandbox + '-reader', reports_to: 'Thoughts-I' } } }));

  const doorman = P('fake-doorman.py'), reader = P('fake-reader.py'), effects = P('effects.jsonl');
  fs.writeFileSync(doorman, `#!/usr/bin/env python3
import json,sys
r=json.load(sys.stdin)
with open(${JSON.stringify(P('doorman-calls.jsonl'))},'a') as f: f.write(json.dumps(r)+'\\n')
if r.get('mode')=='plan':
    off='otter' in r.get('looking_for','').lower()
    revision=bool(r.get('owner_note'))
    searches=['sea otter social bonding observations'] if off else ['moisture degradation of lead halide perovskite']
    if revision: searches=['water ingress and encapsulation of perovskite modules']
    print(json.dumps({'ok':True,'refuse':False,'reason':'synthetic public request','searches':searches,'brief':'','public_terms':['perovskite','otter','otters'],'on_task':not off,'task_reason':'unrelated to perovskite task' if off else 'on the fixture task','drift':False,'drift_reason':''}))
else:
    print(json.dumps({'ok':True,'injection':False,'not_what_asked':False,'odd':False,'reason':'synthetic clean report'}))
`, { mode: 0o700 });
  fs.writeFileSync(reader, `#!/usr/bin/env python3
import json,sys
r=json.load(sys.stdin)
with open(${JSON.stringify(P('reader-calls.jsonl'))},'a') as f: f.write(json.dumps(r)+'\\n')
text='# Perovskite fixture report\\n\\nFactual synthetic report [1]. See [source](https://example.org/raw?hidden=yes). <b>Plain text</b>.\\n\\n'+'\\n'.join('- Synthetic observation '+str(i) for i in range(100))+'\\n\\n\\x60\\x60\\x60sh\\nFENCED_PAYLOAD_MUST_NOT_SURVIVE\\n\\x60\\x60\\x60\\n\\nMODEL_REPORT_END'
print(json.dumps({'ok':True,'deliverable':text,'sources':['https://example.org/reference?tracking=hidden#anchor','https://example.org/reference','http://example.net/legacy','https://user:pass@evil.example/path','javascript:alert(1)','https://example.org/a b'],'models':['fixture/search','fixture/report']}))
`, { mode: 0o700 });
  // Fixed hook supplied by J368. Every invocation is recorded and only fixture sandbox names are accepted.
  const opener = P('fake-opener.py');
  fs.writeFileSync(opener, `#!/usr/bin/env python3
import json,sys,os
args=sys.argv[1:]
if os.environ.get('HOME')!=${JSON.stringify(P('home'))} or os.environ.get('XDG_CONFIG_HOME')!=${JSON.stringify(P('config'))} or not os.path.isfile(${JSON.stringify(P('.j376-owned'))}) or args!=['--','https://example.org/gateway-fixture']:
    print('fixture opener refused a non-fixture context or URL',file=sys.stderr);sys.exit(1)
with open(${JSON.stringify(effects)},'a') as f: f.write(json.dumps({'kind':'opener','args':args,'ok':True})+'\\n')
print('fixture browser: opened (no actual browser)')
`, { mode: 0o700 });
  // J393: record the exact service-manager handoff, without a bus, gate child or browser. Never execute supplied argv.
  fs.writeFileSync(P('bin/systemd-run'), `#!/usr/bin/env python3
import sys,re,os,json
a=sys.argv[1:]
url='https://example.org/gateway-fixture'
world=${JSON.stringify(rig.sandbox)}
if os.environ.get('HOME')!=${JSON.stringify(P('home'))} or os.environ.get('XDG_CONFIG_HOME')!=${JSON.stringify(P('config'))} or not os.path.isfile(${JSON.stringify(P('.j376-owned'))}) or len(a)!=13 or a[:6]!=['--user','--wait','--pipe','--collect','--quiet','--property=KillMode=process'] or not re.fullmatch(${JSON.stringify('--unit=hyprpi-open-' + rig.sandbox + '-[0-9a-f]{8}')},a[6]) or a[7]!='--setenv=HYPRPI_G_AGENT_OPENER='+${JSON.stringify(opener)} or a[8:]!=['python3',${JSON.stringify(fileURLToPath(new URL('../../docker/world/g_open_url.py', import.meta.url)))},'--agent',url,world]:
    print('fixture systemd-run refused unsupported operation',file=sys.stderr);sys.exit(97)
with open(${JSON.stringify(effects)},'a') as f: f.write(json.dumps({'kind':'opener-request','args':a,'url':url,'sandbox':world,'ok':True})+'\\n')
print('fixture manager accepted handoff; no actual service or browser')
`, { mode: 0o700 });
  // sbx is NEVER called for real. The exact production handler still chooses the policy/mount operation.
  const sbx = P('fake-sbx.py');
  fs.writeFileSync(sbx, `#!/usr/bin/env python3
import json,sys
args=sys.argv[1:]
with open(${JSON.stringify(effects)},'a') as f: f.write(json.dumps({'kind':'sbx','args':args})+'\\n')
if not any(a.startswith('j376-') for a in args):
    print('fixture sbx refused a non-fixture sandbox',file=sys.stderr);sys.exit(1)
if args and args[0] in ['policy','mount','unmount','inspect','list']:
    print('[]' if args[0]=='list' else 'fixture operation recorded');sys.exit(0)
print('fixture sbx refuses unsupported operations',file=sys.stderr);sys.exit(1)
`, { mode: 0o700 });
  // The owner container sees bin RO, not the host-effects log or root/fake-sbx.py. Its config-set policy sync is inert too.
  fs.writeFileSync(P('bin/sbx'), `#!/usr/bin/env python3\nimport sys,re\na=sys.argv[1:]\nif len(a)<5 or a[:3] not in [['policy','allow','network'],['policy','rm','network']] or '--sandbox' not in a or not re.fullmatch(r'j376-[a-z0-9-]+',a[a.index('--sandbox')+1]):\n    print('owner fixture sbx refuses non-fixture policy operation',file=sys.stderr);sys.exit(97)\nprint('fixture reader policy recorded; no real policy changed')\n`, { mode: 0o700 });
  Object.assign(rig.env, {
    HYPRPI_RESEARCH_FAKE_DOORMAN: doorman, HYPRPI_RESEARCH_FAKE_READER: reader,
    HYPRPI_RESEARCH_DIRECT: '1', HYPRPI_SBX: sbx, HYPRPI_G_AGENT_OPENER: opener,
  });
  return { worldFile, relayFile: P('config/hyprpi/sbx-relay.json') };
}
export function jsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
