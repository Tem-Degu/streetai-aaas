import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, listFiles, readJson } from '../../utils/workspace.js';

export function transactionsCommand(action, arg) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  switch (action) {
    case 'list': return txnList(paths, arg);
    case 'view': return txnView(paths, arg);
    case 'stats': return txnStats(paths);
  }
}

function loadTransactions(paths, includeArchived = false) {
  const txns = [];

  for (const f of listFiles(paths.activeTransactions, '.json')) {
    const data = readJson(path.join(paths.activeTransactions, f));
    if (data) txns.push({ ...data, _file: f, _location: 'active' });
  }

  if (includeArchived) {
    for (const f of listFiles(paths.archivedTransactions, '.json')) {
      const data = readJson(path.join(paths.archivedTransactions, f));
      if (data) txns.push({ ...data, _file: f, _location: 'archive' });
    }
  }

  return txns.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

const STATUS_COLORS = {
  exploring: chalk.gray,
  proposed: chalk.blue,
  accepted: chalk.cyan,
  in_progress: chalk.yellow,
  delivered: chalk.magenta,
  completed: chalk.green,
  rejected: chalk.gray,
  disputed: chalk.red,
  resolved: chalk.green,
  cancelled: chalk.gray
};

function colorStatus(status) {
  const fn = STATUS_COLORS[status] || chalk.white;
  return fn(status);
}

function txnList(paths, opts) {
  const txns = loadTransactions(paths, opts.all);

  if (txns.length === 0) {
    console.log(chalk.gray('\n  No transactions found.\n'));
    return;
  }

  const filtered = opts.status
    ? txns.filter(t => t.status === opts.status)
    : txns;

  console.log(chalk.blue(`\nTransactions${opts.all ? ' (all)' : ' (active)'}:\n`));

  for (const txn of filtered) {
    const id = txn.id || txn._file;
    const user = txn.user_name || txn.user_id || '?';
    const service = txn.service || '?';
    const cost = txn.cost ? `${txn.cost} TK` : 'Free';
    const status = colorStatus(txn.status);
    const rating = txn.rating ? `${txn.rating}★` : '';

    console.log(`  ${chalk.bold(id)}  ${user} — ${service}`);
    console.log(`  ${status}  ${chalk.gray(cost)}  ${rating}`);
    if (txn.created_at) console.log(chalk.gray(`  ${new Date(txn.created_at).toLocaleString()}`));
    console.log('');
  }
}

function txnView(paths, id) {
  // Search both active and archive
  const allDirs = [
    { dir: paths.activeTransactions, label: 'active' },
    { dir: paths.archivedTransactions, label: 'archive' }
  ];

  for (const { dir, label } of allDirs) {
    for (const f of listFiles(dir, '.json')) {
      const data = readJson(path.join(dir, f));
      if (!data) continue;
      if (data.id === id || f === id || f === `${id}.json`) {
        console.log(chalk.blue(`\nTransaction: ${data.id || f}`) + chalk.gray(` (${label})\n`));
        console.log(chalk.gray('  Field                 Value'));
        console.log(chalk.gray('  ' + '─'.repeat(55)));

        const fields = [
          ['Status', colorStatus(data.status)],
          ['Type', data.type || 'one-time'],
          ['User', data.user_name || data.user_id],
          ['Service', data.service],
          ['Cost', data.cost ? `${data.cost} TK` : 'Free'],
          ['Created', data.created_at ? new Date(data.created_at).toLocaleString() : '—'],
          ['Updated', data.updated_at ? new Date(data.updated_at).toLocaleString() : '—'],
          ['Completed', data.completed_at ? new Date(data.completed_at).toLocaleString() : '—'],
          ['Rating', data.rating ? `${data.rating} ★` : '—'],
          ['Summary', data.summary || '—']
        ];

        for (const [key, value] of fields) {
          console.log(`  ${key.padEnd(22)}${value}`);
        }

        if (data.deliverables?.length) {
          console.log(`\n  ${chalk.blue('Deliverables:')}`);
          for (const d of data.deliverables) {
            console.log(`    ${d.type}: ${d.description || d.path || '?'}`);
          }
        }

        if (data.dispute) {
          console.log(`\n  ${chalk.red('Dispute:')}`);
          console.log(`    Reason: ${data.dispute.reason}`);
          if (data.dispute.resolution) console.log(`    Resolution: ${data.dispute.resolution}`);
        }

        if (data.sub_transactions?.length) {
          console.log(`\n  ${chalk.blue('Sub-transactions:')}`);
          for (const sub of data.sub_transactions) {
            console.log(`    ${sub.extension}: ${sub.service} — ${sub.cost || 0} TK (${sub.status})`);
          }
        }

        if (data.notes) {
          console.log(`\n  ${chalk.gray('Notes:')} ${data.notes}`);
        }

        console.log('');
        return;
      }
    }
  }

  console.error(chalk.red(`\n  Transaction '${id}' not found.\n`));
}

function txnStats(paths) {
  const all = loadTransactions(paths, true);
  const active = all.filter(t => t._location === 'active');
  const archived = all.filter(t => t._location === 'archive');
  const completed = all.filter(t => t.status === 'completed');
  const disputed = all.filter(t => t.status === 'disputed' || t.dispute);
  const cancelled = all.filter(t => t.status === 'cancelled' || t.status === 'rejected');

  const totalRevenue = completed.reduce((sum, t) => sum + (t.cost || 0), 0);
  const ratings = all.filter(t => t.rating).map(t => t.rating);
  const avgRating = ratings.length > 0
    ? (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1)
    : 'N/A';

  const successRate = archived.length > 0
    ? Math.round((completed.length / archived.length) * 100)
    : 0;

  console.log(chalk.blue('\nTransaction Statistics:\n'));
  console.log(`  Total:         ${all.length}`);
  console.log(`  Active:        ${active.length}`);
  console.log(`  Completed:     ${chalk.green(completed.length)}`);
  console.log(`  Disputed:      ${disputed.length > 0 ? chalk.red(disputed.length) : 0}`);
  console.log(`  Cancelled:     ${cancelled.length}`);
  console.log('');
  console.log(`  Revenue:       ${chalk.green(totalRevenue + ' TK')}`);
  console.log(`  Success rate:  ${successRate}%`);
  console.log(`  Avg rating:    ${avgRating}${ratings.length > 0 ? ' ★' : ''}`);
  console.log(`  Total ratings: ${ratings.length}`);

  // Revenue by service
  const byService = {};
  for (const t of completed) {
    const svc = t.service || 'Unknown';
    byService[svc] = (byService[svc] || 0) + (t.cost || 0);
  }
  if (Object.keys(byService).length > 0) {
    console.log(chalk.blue('\n  Revenue by service:'));
    for (const [svc, rev] of Object.entries(byService).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${svc}: ${rev} TK`);
    }
  }

  console.log('');
}
