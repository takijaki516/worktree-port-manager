const port = Number(process.argv[2] || process.env.PORT || 0);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () => new Response("worktree-manager test server"),
});
console.log(`Listening on ${server.port}`);
