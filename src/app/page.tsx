export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: 640 }}>
      <h1>Trend Radar</h1>
      <p>
        This bot has no public web UI. It discovers TikTok/Instagram trends and delivers results via
        Telegram — see the project README.
      </p>
      <p>
        Status: <strong>Phase 0</strong> (bootstrap). Provider, database, and Telegram functionality
        are not implemented yet.
      </p>
      <p>
        <a href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
