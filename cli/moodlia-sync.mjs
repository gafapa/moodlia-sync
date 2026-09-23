#!/usr/bin/env node
import { reportMoodliaSyncCliError, runMoodliaSyncCli } from './runner.mjs';

runMoodliaSyncCli().catch(reportMoodliaSyncCliError);
