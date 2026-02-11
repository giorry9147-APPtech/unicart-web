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
        background: "#f4f4f5",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 600 }}>
        UniCart Backend
      </h1>

      <p style={{ marginTop: 10 }}>
        Status: <strong>Online ✅</strong>
      </p>

      <p style={{ marginTop: 20 }}>
        Test health endpoint:
      </p>

      <a
        href="/api/health"
        style={{
          marginTop: 8,
          color: "#6C3BFF",
          textDecoration: "underline",
        }}
      >
        /api/health
      </a>
    </main>
  );
}
