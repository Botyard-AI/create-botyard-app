#!/usr/bin/env node
import { defaultIo, main } from "./cli.ts"

process.exitCode = await main(process.argv.slice(2), defaultIo())
