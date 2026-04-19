import { Hono } from "hono";
import type { HonoEnv } from "../env";

const app = new Hono<HonoEnv>();

app.get("/healthz", (c) => c.json({ status: "ok" }));

export default app;
