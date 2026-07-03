import chalk from 'chalk';

/**
 * aaas update-image [--redeploy]
 *
 * Rolls the StreetAI server to the latest aaas base image. The image itself is
 * built + pushed to ghcr by GitHub Actions (on a version tag or the "Run
 * workflow" button) — this command tells the server to `docker pull` it and,
 * with --redeploy, recreate every hosted agent onto it (data preserved).
 *
 * Auth: the same admin key as `publish` (--key or $STREETAI_PUBLISH_KEY).
 */
export async function updateImageCommand(options = {}) {
  const server = (options.server || process.env.STREETAI_PUBLISH_URL || 'https://streetai.org').replace(/\/$/, '');
  const key = options.key || process.env.STREETAI_PUBLISH_KEY;
  const redeploy = !!options.redeploy;

  if (!key) {
    console.error(chalk.red('\n  Error: no admin key. Set $STREETAI_PUBLISH_KEY or pass --key.\n'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.gray(`  Pulling the latest image on ${server}${redeploy ? ' and redeploying hosted agents' : ''} ...`));
  console.log(chalk.gray('  (the image is built + published by GitHub Actions — trigger that first if you pushed new code)'));

  let data;
  try {
    const resp = await fetch(`${server}/admin/image-pull`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, ...(redeploy ? { 'X-Redeploy': '1' } : {}) },
    });
    data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `Server returned ${resp.status}`);
  } catch (err) {
    console.error(chalk.red(`\n  Failed: ${err.message}\n`));
    process.exit(1);
  }

  console.log(chalk.green('\n  Image updated on the server.'));
  console.log(chalk.gray(`  ${data.image}`));
  if (data.redeploy) {
    console.log(chalk.green(`  Redeployed ${data.redeploy.recreated}/${data.redeploy.total} hosted agent(s).`));
    for (const r of data.redeploy.results || []) {
      if (r.error) console.log(chalk.yellow(`    ${r.slug}: ${r.error}`));
    }
  } else {
    console.log(chalk.gray('  Run with --redeploy to roll hosted agents onto it, or use the admin Control tab.'));
  }
  console.log('');
}
