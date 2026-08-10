import { rmSync } from "node:fs";

rmSync(new URL("../dist/ts", import.meta.url), { recursive: true, force: true });
