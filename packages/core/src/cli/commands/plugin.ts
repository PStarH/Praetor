/**
 * Plugin CLI Commands — Install, list, uninstall, enable, disable Commander plugins.
 *
 * Usage:
 *   commander plugin install <source>   Install a plugin (npm/git/local)
 *   commander plugin list (ls)          List installed plugins
 *   commander plugin uninstall <name>   Uninstall a plugin
 *   commander plugin enable <name>      Persistently enable a plugin
 *   commander plugin disable <name>     Persistently disable a plugin
 *   commander plugin info <name>        Show plugin details
 */
import { section, kv, $, startSpinner } from '../util';

export async function cmdPlugin(subargs: string[]) {
  const sub = subargs[0] || 'help';

  // ── plugin install <source> ──
  if (sub === 'install') {
    const source = subargs[1];
    if (!source) {
      console.error(`  ${$.red}Usage:${$.reset} commander plugin install <source>\n`);
      console.log(`  ${$.dim}Sources:${$.reset}`);
      console.log(`    ${$.cyan}npm-package-name${$.reset}       Install from npm`);
      console.log(`    ${$.cyan}github:user/repo${$.reset}      Install from git`);
      console.log(`    ${$.cyan}./path/to/plugin${$.reset}      Install from local directory`);
      console.log();
      return;
    }

    const done = startSpinner(`Installing plugin from ${source}...`);
    try {
      const { getPluginLoader } = await import('../../pluginLoader');
      const loader = getPluginLoader();

      let pluginDir: string;
      if (source.startsWith('.') || source.startsWith('/')) {
        // Local path — load directly from directory
        pluginDir = source;
        await loader.loadPlugin(pluginDir);
      } else {
        pluginDir = await loader.installFromNpm(source);
        await loader.loadPlugin(pluginDir);
      }

      done();
      console.log(`  ${$.green}✓${$.reset} Plugin installed successfully\n`);
    } catch (err) {
      done();
      console.error(
        `  ${$.red}Installation failed: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`,
      );
    }
    return;
  }

  // ── plugin list / ls ──
  if (sub === 'list' || sub === 'ls') {
    const { getPluginLoader } = await import('../../pluginLoader');
    const loader = getPluginLoader();
    const loaded = loader.getLoadedPlugins();

    if (loaded.length === 0) {
      console.log(`\n  ${$.dim}No plugins loaded.${$.reset}\n`);
      console.log(
        `  ${$.dim}Install a plugin with:${$.reset} ${$.cyan}commander plugin install <name>${$.reset}\n`,
      );
      return;
    }

    section(`PLUGINS (${loaded.length})`);
    for (const pkg of loaded) {
      const enabled = loader.isEnabled(pkg.manifest.name);
      const status = enabled ? `${$.green}●${$.reset}` : `${$.red}○${$.reset}`;
      const stateLabel = enabled ? `${$.green}enabled${$.reset}` : `${$.red}disabled${$.reset}`;
      console.log(
        `  ${status} ${$.bold}${pkg.manifest.name}${$.reset} ${$.dim}v${pkg.manifest.version}${$.reset} [${stateLabel}]`,
      );
      console.log(`    ${$.dim}${pkg.directory}${$.reset}`);
    }
    console.log();
    return;
  }

  // ── plugin uninstall <name> ──
  if (sub === 'uninstall' || sub === 'rm' || sub === 'remove') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander plugin uninstall <name>\n`);
      return;
    }

    try {
      const { getPluginLoader } = await import('../../pluginLoader');
      const loader = getPluginLoader();
      const success = await loader.unloadPlugin(name);
      if (success) {
        console.log(`  ${$.green}✓${$.reset} Plugin "${$.bold}${name}${$.reset}" uninstalled\n`);
      } else {
        console.error(`  ${$.red}Plugin "${name}" not found${$.reset}\n`);
      }
    } catch (err) {
      console.error(`  ${$.red}${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
    }
    return;
  }

  // ── plugin enable <name> ──
  if (sub === 'enable') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander plugin enable <name>\n`);
      return;
    }

    const { getPluginLoader } = await import('../../pluginLoader');
    const loader = getPluginLoader();
    loader.enable(name);
    console.log(
      `  ${$.green}✓${$.reset} Plugin "${$.bold}${name}${$.reset}" ${$.green}enabled${$.reset}`,
    );
    console.log(`  ${$.dim}It will load on the next startup.${$.reset}\n`);
    return;
  }

  // ── plugin disable <name> ──
  if (sub === 'disable') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander plugin disable <name>\n`);
      return;
    }

    const { getPluginLoader } = await import('../../pluginLoader');
    const loader = getPluginLoader();
    loader.disable(name);
    // If currently loaded, unload it immediately.
    if (loader.isLoaded(name)) {
      await loader.unloadPlugin(name);
      console.log(
        `  ${$.green}✓${$.reset} Plugin "${$.bold}${name}${$.reset}" ${$.red}disabled${$.reset} and unloaded`,
      );
    } else {
      console.log(
        `  ${$.green}✓${$.reset} Plugin "${$.bold}${name}${$.reset}" ${$.red}disabled${$.reset}`,
      );
    }
    console.log(`  ${$.dim}It will be skipped on the next startup.${$.reset}\n`);
    return;
  }

  // ── plugin info <name> ──
  if (sub === 'info') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander plugin info <name>\n`);
      return;
    }

    const { getPluginLoader } = await import('../../pluginLoader');
    const loader = getPluginLoader();
    const loaded = loader.getLoadedPlugins().find((p) => p.manifest.name === name);

    if (!loaded) {
      console.error(`  ${$.red}Plugin "${name}" not found${$.reset}\n`);
      return;
    }

    section(`PLUGIN: ${name}`);
    kv('Name', loaded.manifest.name);
    kv('Version', loaded.manifest.version);
    kv('Description', loaded.manifest.description ?? '(none)');
    kv('Status', 'Loaded', $.green);
    kv('Enabled', loader.isEnabled(name) ? 'yes' : 'no', loader.isEnabled(name) ? $.green : $.red);
    kv('Path', loaded.directory);
    console.log();
    return;
  }

  // ── Help ──
  console.log(`
  ${$.bold}PLUGIN COMMANDS${$.reset}
    ${$.cyan}commander plugin install <source>${$.reset}   Install a plugin (npm/git/local)
    ${$.cyan}commander plugin list${$.reset}               List installed plugins
    ${$.cyan}commander plugin uninstall <name>${$.reset}   Uninstall a plugin
    ${$.cyan}commander plugin enable <name>${$.reset}      Persistently enable a plugin
    ${$.cyan}commander plugin disable <name>${$.reset}     Persistently disable a plugin
    ${$.cyan}commander plugin info <name>${$.reset}        Show plugin details

  ${$.dim}Examples:${$.reset}
    ${$.cyan}commander plugin install @praetor/web-scraper${$.reset}
    ${$.cyan}commander plugin install github:user/repo${$.reset}
    ${$.cyan}commander plugin install ./my-plugin${$.reset}
    ${$.cyan}commander plugin disable my-plugin${$.reset}
    ${$.cyan}commander plugin list${$.reset}
  `);
}
