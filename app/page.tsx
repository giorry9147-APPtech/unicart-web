export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui",
        background: "#111827",
        color: "white",
      }}
    >
      <h1 style={{ fontSize: 36, fontWeight: 700 }}>
        UniCart Backend 🚀
      </h1>

      <p style={{ marginTop: 10, fontSize: 18 }}>
        Production Server Active
      </p>

      <p style={{ marginTop: 20, opacity: 0.7 }}>
        Timestamp:
      </p>

      <p style={{ fontSize: 16, marginTop: 5 }}>
        {new Date().toISOString()}
      </p>

      <a
        href="/api/health"
        style={{
          marginTop: 30,
          color: "#6C3BFF",
          textDecoration: "underline",
        }}
      >
        Check Health Endpoint
      </a>
    </main>
  );
}
