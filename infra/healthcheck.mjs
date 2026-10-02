try {
  const response = await fetch("http://127.0.0.1:3000/health/ready", {
    signal: AbortSignal.timeout(5000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
