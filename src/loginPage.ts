export function buildLoginPageHtml(appTitle: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — ${appTitle}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; }
    body {
      color: #d8ecff;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background-color: #041425;
      background:
        radial-gradient(1200px 500px at 100% -10%, rgba(106,232,206,0.2), transparent 62%),
        radial-gradient(1000px 560px at 0% 100%, rgba(70,130,255,0.26), transparent 64%),
        linear-gradient(155deg, #020913 0%, #041425 46%, #07203b 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: rgba(4, 18, 31, 0.94);
      border: 1px solid rgba(172, 255, 236, 0.36);
      border-radius: 16px;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      padding: 2rem 2.2rem;
      display: flex;
      flex-direction: column;
      gap: 1.2rem;
      align-items: center;
      min-width: 18rem;
      max-width: 22rem;
      width: 90vw;
    }
    .login-title {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .login-input {
      width: 100%;
      padding: 0.65rem 0.8rem;
      border-radius: 10px;
      border: 1px solid rgba(140, 205, 255, 0.35);
      background: rgba(10, 30, 50, 0.8);
      color: #d7ebff;
      font-size: 0.95rem;
      font-family: inherit;
      outline: none;
    }
    .login-input:focus {
      border-color: #6ae8ce;
      box-shadow: 0 0 0 2px rgba(106, 232, 206, 0.25);
    }
    .login-button {
      width: 100%;
      padding: 0.6rem;
      border: none;
      border-radius: 10px;
      background: linear-gradient(to bottom, rgba(106, 232, 206, 0.35), rgba(60, 180, 160, 0.25));
      border: 1px solid rgba(172, 255, 236, 0.6);
      color: #d6fff5;
      font-size: 0.95rem;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: background 150ms ease;
    }
    .login-button:hover {
      background: linear-gradient(to bottom, rgba(106, 232, 206, 0.5), rgba(60, 180, 160, 0.35));
    }
    .login-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .login-error {
      margin: 0;
      font-size: 0.85rem;
      color: #ff8e84;
      min-height: 1.2em;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1 class="login-title">${appTitle}</h1>
    <input class="login-input" type="password" id="secret" placeholder="Enter secret" autocomplete="current-password" autofocus>
    <button class="login-button" id="submit" type="button">Login</button>
    <p class="login-error" id="error"></p>
  </div>
  <script>
    const input = document.getElementById("secret");
    const btn = document.getElementById("submit");
    const err = document.getElementById("error");

    async function doLogin() {
      const secret = input.value;
      if (!secret) { err.textContent = "Please enter a secret."; return; }
      btn.disabled = true;
      err.textContent = "";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret }),
        });
        if (res.ok) {
          window.location.href = "/";
        } else {
          const data = await res.json().catch(() => ({}));
          err.textContent = data.error || "Invalid secret.";
        }
      } catch (e) {
        err.textContent = "Network error.";
      } finally {
        btn.disabled = false;
      }
    }

    btn.addEventListener("click", doLogin);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  </script>
</body>
</html>`;
}
