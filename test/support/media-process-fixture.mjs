const mode = process.argv[2];

if (mode === "succeed") {
  process.stdout.write("completed\n");
  process.exit(0);
}

if (mode === "overflow") {
  process.stderr.write("diagnostic-".repeat(20_000));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "hang") {
  process.stderr.write("waiting for input\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
