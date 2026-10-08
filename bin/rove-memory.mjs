#!/usr/bin/env node
import { main } from '../rove-memory.mjs';

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
