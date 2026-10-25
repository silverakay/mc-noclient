'use strict';

// One bounded live session. No greeting, test chat, test command, ping or reconnect.
const fs = require('fs');
const path = require('path');
const { MCClient } = require('../src/client');
const auth = require('../src/auth');
const { ChatActions } = require('../src/chat_actions');
const { RedPacketAutomation, claimCandidate, chatCategory } = require('../src/red_packet');

async function run() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--confirm-one-connection')) throw new Error('Explicit one-connection confirmation is required');
  const host = argv[argv.indexOf('--host') + 1];
  if (!argv.includes('--host') || !host || host.startsWith('--')) throw new Error('A target host is required');
  const seconds = 120;
  const output = path.resolve(__dirname, '../dist');
  fs.mkdirSync(output, { recursive: true });
  const lock = path.join(output, 'live-receive-cooldown.json');
  if (fs.existsSync(lock)) {
    const last = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (Date.now() - last.startedAt < 15 * 60 * 1000) throw new Error('Live test cooldown: no second attempt within 15 minutes');
  }
  fs.writeFileSync(lock, JSON.stringify({ startedAt: Date.now(), host, connectionLimit: 1 }));
  const report = { startedAt: new Date().toISOString(), host, connectCalls: 0, joined: false,
    stoppedBy: '', chatSends: 0, claimCommands: [], categories: {}, samples: [], redPacketMessages: [], automation: [], events: [] };
  let client = null, deadline = null, observation = null, finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const actions = new ChatActions();
  const allowed = new Set();
  const auto = new RedPacketAutomation({ actions,
    onRecord: (entry) => { report.automation.push(entry); console.log('RED_PACKET ' + entry.status + ': ' + entry.detail); },
  });
  const stop = (reason) => {
    if (report.stoppedBy) return;
    report.stoppedBy = reason;
    clearTimeout(deadline); clearTimeout(observation); auto.resetPending(); actions.reset();
    if (client) client.close();
    finish();
  };
  process.once('SIGINT', () => stop('manual-stop'));
  try {
    console.log('Preparing one live connection; no test messages or reconnects');
    const account = await auth.login({ silentOnly: true });
    if (report.stoppedBy) throw new Error('Live connection cancelled');
    client = new MCClient({ host, port: 25565, username: account.profile.name,
      accessToken: account.accessToken, profileId: account.profile.id, uuid: account.profile.id,
      log: (text) => {
        if (/^\[(TCP|SRV|配置|断开|网络错误|验证失败|被拒绝|被踢出)/.test(text)) console.log(text);
      },
      onEvent: (name, data) => {
        report.events.push(name);
        if (name === 'join') {
          report.joined = true; clearTimeout(deadline);
          console.log('JOINED; receiving natural messages for ' + seconds + ' seconds');
          observation = setTimeout(() => stop('observation-complete'), seconds * 1000);
        } else if (name === 'kick' || name === 'close' || name === 'need-auth') {
          report.disconnectReason = typeof data === 'string' ? data : data && data.reason || name;
          stop(name);
        } else if (name === 'error') { report.error = String(data); stop('error'); }
      },
      onChat: (text, meta = {}) => {
        const category = chatCategory(text, meta.type);
        report.categories[category] = (report.categories[category] || 0) + 1;
        const message = { text, type: meta.type || 'system', session: actions.session, segments: actions.register(meta.segments || []) };
        if (report.samples.length < 20) report.samples.push({ text, type: message.type, category });
        if (category === 'redpacket' && report.redPacketMessages.length < 30) {
          report.redPacketMessages.push({ text, clicks: message.segments.filter((p) => p.click)
            .map((p) => ({ text: p.text, action: p.click.action, value: p.click.value })) });
        }
        const candidate = claimCandidate(message);
        if (candidate && candidate.action === 'run_command') allowed.add(candidate.value.replace(/^\//, ''));
        auto.handle(message, client, { enabled: argv.includes('--allow-auto-claim'), serverKey: host + ':25565' })
          .catch((e) => { report.error = e.message; stop('automation-error'); });
      },
    });
    client.say = () => { report.chatSends++; throw new Error('Live test chat sending is forbidden'); };
    const command = client.command.bind(client);
    client.command = (value) => {
      if (!argv.includes('--allow-auto-claim') || !allowed.delete(value)) throw new Error('Only a natural server-supplied claim command is allowed');
      const sent = command(value);
      report.claimCommands.push({ command: value, sent });
      return sent;
    };
    deadline = setTimeout(() => stop('login-timeout'), 45000);
    report.connectCalls++;
    await client.connect();
    await done;
  } catch (e) {
    report.error = e.message; stop('failed');
  } finally {
    stop('complete');
    report.finishedAt = new Date().toISOString();
    report.diagnostics = client ? client.getChatDiagnostics() : null;
    const file = path.join(output, 'live-receive-' + require('../package.json').version + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: file, joined: report.joined, connectCalls: report.connectCalls,
      chatSends: report.chatSends, claimCommands: report.claimCommands.length, categories: report.categories,
      stoppedBy: report.stoppedBy, error: report.error || null }));
    process.exitCode = report.joined && report.chatSends === 0 && report.connectCalls === 1 ? 0 : 1;
  }
}
run().catch((e) => { console.error(e.message); process.exitCode = 1; });
