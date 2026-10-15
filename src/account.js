(() => {
  "use strict";

  const page = document.body.dataset.accountPage;
  const form = document.querySelector("[data-account-form]");
  const status = document.querySelector("[data-form-status]");
  const submit = form?.querySelector('button[type="submit"]');

  function show(message, kind = "info") {
    if (!status) return;
    status.textContent = message || "";
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function setBusy(busy, label = "Working...") {
    if (!submit) return;
    if (busy) {
      submit.dataset.originalLabel = submit.textContent;
      submit.textContent = label;
    } else {
      submit.textContent = submit.dataset.originalLabel || submit.textContent;
    }
    submit.disabled = busy;
    form?.setAttribute("aria-busy", String(busy));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
      ...options,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data.error || "The request could not be completed.");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  function jsonOptions(method, body, csrfToken = "") {
    return {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: JSON.stringify(body),
    };
  }

  function returnPath(fallback = "/library.html") {
    const value = new URLSearchParams(window.location.search).get("return") || fallback;
    return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
      ? value
      : fallback;
  }

  function fragmentToken() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token") || "";
    if (token) history.replaceState(null, "", `${location.pathname}${location.search}`);
    return token;
  }

  function formValues() {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function currentAccount() {
    return api("/api/account/me");
  }

  async function setupLogin() {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      setBusy(true, "Logging In...");
      show("");
      try {
        const values = formValues();
        const data = await api(
          "/api/account/login",
          jsonOptions("POST", { email: values.email, password: values.password })
        );
        show(data.message, "success");
        const target = returnPath();
        window.location.assign(
          data.user.emailVerified
            ? target
            : `/verify-email.html?return=${encodeURIComponent(target)}`
        );
      } catch (error) {
        show(error.message, "error");
        setBusy(false);
      }
    });
  }

  async function setupRegister() {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = formValues();
      if (values.password !== values.confirmPassword) {
        show("Passwords do not match.", "error");
        return;
      }
      setBusy(true, "Creating Account...");
      show("");
      try {
        const data = await api(
          "/api/account/register",
          jsonOptions("POST", {
            displayName: values.displayName,
            email: values.email,
            password: values.password,
          })
        );
        show(data.message, "success");
        if (data.user) {
          const target = returnPath();
          const delivery = data.emailSent === false ? "&delivery=failed" : "";
          window.location.assign(
            `/verify-email.html?return=${encodeURIComponent(target)}${delivery}`
          );
        } else {
          setBusy(false);
        }
      } catch (error) {
        show(error.message, "error");
        setBusy(false);
      }
    });
  }

  async function setupForgot() {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      setBusy(true, "Sending Link...");
      show("");
      try {
        const values = formValues();
        const data = await api(
          "/api/account/forgot-password",
          jsonOptions("POST", { email: values.email })
        );
        show(data.message, "success");
        form.reset();
      } catch (error) {
        show(error.message, "error");
      } finally {
        setBusy(false);
      }
    });
  }

  async function setupReset() {
    const token = fragmentToken();
    if (!token) {
      show("This password-reset link is missing or invalid.", "error");
      if (submit) submit.disabled = true;
      return;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = formValues();
      if (values.password !== values.confirmPassword) {
        show("Passwords do not match.", "error");
        return;
      }
      setBusy(true, "Updating Password...");
      show("");
      try {
        const data = await api(
          "/api/account/reset-password",
          jsonOptions("POST", { token, password: values.password })
        );
        show(data.message, "success");
        form.hidden = true;
        document.querySelector("[data-after-reset]")?.removeAttribute("hidden");
      } catch (error) {
        show(error.message, "error");
        setBusy(false);
      }
    });
  }

  async function setupVerify() {
    const token = fragmentToken();
    const resend = document.querySelector("[data-resend-verification]");
    const continueLink = document.querySelector("[data-verified-continue]");
    if (continueLink) continueLink.href = returnPath();
    let account = null;
    try {
      account = await currentAccount();
    } catch {
      account = null;
    }

    if (token) {
      setBusy(true, "Verifying...");
      try {
        const data = await api(
          "/api/account/verify-email",
          jsonOptions("POST", { token })
        );
        show(data.message, "success");
        document.querySelector("[data-verified-actions]")?.removeAttribute("hidden");
        if (form) form.hidden = true;
      } catch (error) {
        show(error.message, "error");
      } finally {
        setBusy(false);
      }
    } else if (account?.user.emailVerified) {
      show("Your email is already verified.", "success");
      document.querySelector("[data-verified-actions]")?.removeAttribute("hidden");
    } else {
      show(
        new URLSearchParams(location.search).get("delivery") === "failed"
          ? "Your account was created, but email delivery failed. Check the provider configuration or request a new link below."
          : account
          ? "Check your inbox for a verification link. You can request a new one below."
          : "Log in to request another verification email.",
        "info"
      );
    }

    resend?.addEventListener("click", async () => {
      if (!account) {
        window.location.assign(
          `/login.html?return=${encodeURIComponent(location.pathname + location.search)}`
        );
        return;
      }
      resend.disabled = true;
      try {
        const data = await api(
          "/api/account/resend-verification",
          jsonOptions("POST", {}, account.csrfToken)
        );
        show(data.message, data.emailSent === false ? "error" : "success");
      } catch (error) {
        show(error.message, "error");
      } finally {
        resend.disabled = false;
      }
    });
  }

  async function setupAccount() {
    let account;
    try {
      account = await currentAccount();
    } catch {
      window.location.replace(
        `/login.html?return=${encodeURIComponent(location.pathname + location.search)}`
      );
      return;
    }
    form.elements.displayName.value = account.user.displayName || "";
    form.elements.email.value = account.user.email;
    const verified = document.querySelector("[data-verification-state]");
    if (verified) {
      verified.textContent = account.user.emailVerified ? "Verified" : "Verification required";
      verified.dataset.verified = String(account.user.emailVerified);
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = formValues();
      if (values.newPassword && values.newPassword !== values.confirmPassword) {
        show("New passwords do not match.", "error");
        return;
      }
      setBusy(true, "Saving...");
      try {
        const payload = {
          displayName: values.displayName,
          email: values.email,
        };
        if (values.currentPassword) payload.currentPassword = values.currentPassword;
        if (values.newPassword) payload.newPassword = values.newPassword;
        const data = await api(
          "/api/account",
          jsonOptions("PATCH", payload, account.csrfToken)
        );
        account = { ...account, user: data.user, csrfToken: data.csrfToken };
        form.elements.currentPassword.value = "";
        form.elements.newPassword.value = "";
        form.elements.confirmPassword.value = "";
        show(data.message, "success");
        if (verified) {
          verified.textContent = data.user.emailVerified ? "Verified" : "Verification required";
          verified.dataset.verified = String(data.user.emailVerified);
        }
      } catch (error) {
        show(error.message, "error");
      } finally {
        setBusy(false);
      }
    });
    document.querySelector("[data-revoke-sessions]")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        const data = await api(
          "/api/account/sessions/revoke-others",
          jsonOptions("POST", {}, account.csrfToken)
        );
        show(data.message, "success");
      } catch (error) {
        show(error.message, "error");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
    setupLogout(account);
  }

  function setupLogout(account) {
    document.querySelectorAll("[data-logout]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api("/api/account/logout", jsonOptions("POST", {}, account.csrfToken));
          window.location.assign("/");
        } catch (error) {
          show(error.message, "error");
          button.disabled = false;
        }
      });
    });
  }

  function renderLibrary(books, account) {
    const grid = document.querySelector("[data-library-grid]");
    const empty = document.querySelector("[data-library-empty]");
    grid.replaceChildren();
    empty.hidden = books.length > 0;
    books.forEach((book) => {
      const article = document.createElement("article");
      article.className = "library-book";
      const image = document.createElement("img");
      image.src = book.image;
      image.alt = `${book.title} cover`;
      image.width = 220;
      image.height = 350;
      const body = document.createElement("div");
      body.className = "library-book__body";
      const eyebrow = document.createElement("p");
      eyebrow.className = "account-eyebrow";
      eyebrow.textContent = book.number ? `Book ${book.number}` : "Tartarian Chronicles";
      const title = document.createElement("h2");
      title.textContent = book.title;
      const date = document.createElement("p");
      date.className = "library-book__date";
      date.textContent = `Purchased ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(book.firstPurchasedAt || book.purchaseDate))}`;
      const actions = document.createElement("div");
      actions.className = "library-book__actions";
      book.formats.forEach((format) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = format === "epub" ? "btn btn--solid" : "btn btn--outline-dark";
        button.textContent = `Download ${format.toUpperCase()}`;
        button.addEventListener("click", async () => {
          button.disabled = true;
          const original = button.textContent;
          button.textContent = "Preparing...";
          try {
            const data = await api(
              `/api/library/${encodeURIComponent(book.id)}/download`,
              jsonOptions("POST", { format }, account.csrfToken)
            );
            window.location.assign(data.url);
          } catch (error) {
            show(error.message, "error");
            button.disabled = false;
            button.textContent = original;
          }
        });
        actions.append(button);
      });
      body.append(eyebrow, title, date, actions);
      article.append(image, body);
      grid.append(article);
    });
  }

  async function setupLibrary() {
    let account;
    try {
      account = await currentAccount();
      if (!account.user.emailVerified) {
        window.location.replace(
          `/verify-email.html?return=${encodeURIComponent(location.pathname)}`
        );
        return;
      }
      const data = await api("/api/library");
      renderLibrary(data.books || [], account);
      setupLogout(account);
    } catch (error) {
      if (error.status === 401) {
        window.location.replace(`/login.html?return=${encodeURIComponent(location.pathname)}`);
      } else {
        show(error.message, "error");
      }
    } finally {
      document.querySelector("[data-library-loading]")?.setAttribute("hidden", "");
    }
  }

  async function setupClaim() {
    const token = fragmentToken();
    const actions = document.querySelector("[data-claim-auth-actions]");
    if (!token) {
      show("This purchase-claim link is missing or invalid.", "error");
      return;
    }
    let account;
    try {
      account = await currentAccount();
    } catch {
      const destination = `/claim-purchase.html#token=${encodeURIComponent(token)}`;
      actions?.removeAttribute("hidden");
      actions?.querySelectorAll("a").forEach((link) => {
        link.href = `${link.dataset.base}?return=${encodeURIComponent(destination)}`;
      });
      show("Log in or create an account with the purchase email to continue.", "info");
      return;
    }
    if (!account.user.emailVerified) {
      const destination = `/claim-purchase.html#token=${encodeURIComponent(token)}`;
      show("Verify your account email before claiming this purchase.", "info");
      const verify = document.querySelector("[data-claim-verify]");
      if (verify) {
        verify.href = `/verify-email.html?return=${encodeURIComponent(destination)}`;
        verify.hidden = false;
      }
      return;
    }
    show("Confirming ownership and adding the books to your library...", "info");
    try {
      const data = await api(
        "/api/account/claim-purchase",
        jsonOptions("POST", { token }, account.csrfToken)
      );
      show(data.message, "success");
      document.querySelector("[data-claim-complete]")?.removeAttribute("hidden");
    } catch (error) {
      show(error.message, "error");
    }
  }

  const setup = {
    login: setupLogin,
    register: setupRegister,
    forgot: setupForgot,
    reset: setupReset,
    verify: setupVerify,
    account: setupAccount,
    library: setupLibrary,
    claim: setupClaim,
  }[page];
  if (setup) setup();
})();
