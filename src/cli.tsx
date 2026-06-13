#!/usr/bin/env node
import 'dotenv/config';
import React from 'react';
import {Command} from 'commander';
import {render} from 'ink';
import {resolve} from 'node:path';
import {App} from './ui/App.js';
import {createAgentConfig} from './config.js';

const program = new Command();

program
  .name('cerebras-agent')
  .description('Launch an AI coding agent in your terminal.')
  .option('--cwd [path]', 'Workspace directory', process.cwd())
  .option('--provider <name>', 'Model provider name')
  .option('--model <name>', 'Model name')
  .option('--auto-approve-readonly', 'Run read-only tools without prompting', true)
  .parse(process.argv);

const options = program.opts<{
  cwd: string | boolean;
  provider?: string;
  model?: string;
  autoApproveReadonly: boolean;
}>();

const config = createAgentConfig({
  cwd: resolve(typeof options.cwd === 'string' ? options.cwd : process.cwd()),
  provider: options.provider,
  model: options.model,
  autoApproveReadonly: options.autoApproveReadonly
});

const useAlternateScreen = process.stdout.isTTY && process.env.TERM !== 'dumb';
let alternateScreenActive = false;
let mouseReportingActive = false;

function disableMouseReporting() {
  if (!mouseReportingActive) {
    return;
  }

  mouseReportingActive = false;
  process.stdout.write('\u001B[?1000l\u001B[?1006l');
}

function leaveAlternateScreen() {
  disableMouseReporting();

  if (!alternateScreenActive) {
    return;
  }

  alternateScreenActive = false;
  process.stdout.write('\u001B[?1049l');
}

if (useAlternateScreen) {
  alternateScreenActive = true;
  mouseReportingActive = true;
  process.stdout.write('\u001B[?1049h\u001B[?1000h\u001B[?1006h\u001B[2J\u001B[H');
  process.once('exit', leaveAlternateScreen);
}

const app = render(<App config={config} />);

try {
  await app.waitUntilExit();
} finally {
  app.unmount();
  leaveAlternateScreen();
}
