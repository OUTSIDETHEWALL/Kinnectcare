---
name: Motion wake diagnostics
description: Durable rules for tracing Android motion evidence through the location and upload pipeline.
---

## Motion Timeline rule

Every motion diagnostic signal must be recorded through the engine ring buffer and included in the Motion Timeline with an accurate source label.

**Why:** A partial timeline can make an Android restriction, SDK transition failure, and GPS/upload failure look identical.

**How to apply:** Show the full activity → motion/recovery → GPS → queued upload → HTTP result chain. Label JS and headless recovery separately.

## Android headless event contract

Transistor SDK 5.x headless events carry event data in `event.params`. Compatibility fallbacks may remain for older payload shapes.

**Why:** Reading the wrong payload location interprets valid moving evidence as stationary and skips the GPS/upload chain.

**How to apply:** Headless handlers and tests must use `params`-shaped events. Do not use deprecated Activity Recognition configuration fields as a wake fix.