import { scalarText } from "../shared/contracts.js";
import * as z from "zod";
import { AppError, errorMessage, accountResponseSchema, messageResponseSchema, libraryResponseSchema, downloadResponseSchema } from "../shared/contracts.js";
import type { AccountResponse, LibraryBook } from "../shared/contracts.js";
import { element, optionalElement, input, formValues as readFormValues, requestJson, jsonOptions } from "./browser.js";
(() => {
  "use strict";

  const page = document.body.dataset.accountPage;
  const form = optionalElement("[data-account-form]", HTMLFormElement);
  const status = optionalElement("[data-form-status]", HTMLElement);
  const submit = form ? optionalElement('button[type="submit"]', HTMLButtonElement, form) : null;
  function accountForm(): HTMLFormElement { if (!form) throw new Error("This page is missing its account accountForm()."); return form; }

  function show(message: string | undefined, kind = "info") {
    if (!status) return;
    status.textContent = message || "";
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function setBusy(busy: boolean, label = "Working...") {
    if (!submit) return;
    if (busy) {
      submit.dataset.originalLabel = submit.textContent;
      submit.textContent = label;
    } else {
      submit.textContent = submit.dataset.originalLabel || submit.textContent;
    }
    submit.disabled = busy;
    form?.setAttribute("aria-busy", scalarText(busy));
  }

  const accountMutationSchema = accountResponseSchema.extend({ message: z.string().optional() });
  function api(path: "/api/account/me" | "/api/account/login" | "/api/account", options?: RequestInit): Promise<z.infer<typeof accountMutationSchema>>;
  function api(path: "/api/library", options?: RequestInit): Promise<z.infer<typeof libraryResponseSchema>>;
  function api(path: `/api/library/${string}/download`, options?: RequestInit): Promise<z.infer<typeof downloadResponseSchema>>;
  function api(path: string, options?: RequestInit): Promise<z.infer<typeof messageResponseSchema>>;
  async function api(path: string, options: RequestInit = {}) {
    if (["/api/account/me", "/api/account/login", "/api/account"].includes(path)) return requestJson(path, accountMutationSchema, options);
    if (path === "/api/library") return requestJson(path, libraryResponseSchema, options);
    if (path.startsWith("/api/library/")) return requestJson(path, downloadResponseSchema, options);
    return requestJson(path, messageResponseSchema, options);
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

  function formValues() { return readFormValues(accountForm()); }

  async function currentAccount() {
    return api("/api/account/me");
  }

  async function setupLogin() {
    accountForm().addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!accountForm().reportValidity()) return;
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
        show(errorMessage(error), "error");
        setBusy(false);
      }
    });
  }

  async function setupRegister() {
    accountForm().addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!accountForm().reportValidity()) return;
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
        show(errorMessage(error), "error");
        setBusy(false);
      }
    });
  }

  async function setupForgot() {
    accountForm().addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!accountForm().reportValidity()) return;
      setBusy(true, "Sending Link...");
      show("");
      try {
        const values = formValues();
        const data = await api(
          "/api/account/forgot-password",
          jsonOptions("POST", { email: values.email })
        );
        show(data.message, "success");
        accountForm().reset();
      } catch (error) {
        show(errorMessage(error), "error");
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
    accountForm().addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!accountForm().reportValidity()) return;
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
        accountForm().hidden = true;
        optionalElement("[data-after-reset]", HTMLElement)?.removeAttribute("hidden");
      } catch (error) {
        show(errorMessage(error), "error");
        setBusy(false);
      }
    });
  }

  async function setupVerify() {
    const token = fragmentToken();
    const resend = optionalElement("[data-resend-verification]", HTMLButtonElement);
    const continueLink = optionalElement("[data-verified-continue]", HTMLAnchorElement);
    if (continueLink) continueLink.href = returnPath();
    let account: AccountResponse | null = null;
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
        optionalElement("[data-verified-actions]", HTMLElement)?.removeAttribute("hidden");
        if (form) accountForm().hidden = true;
      } catch (error) {
        show(errorMessage(error), "error");
      } finally {
        setBusy(false);
      }
    } else if (account?.user.emailVerified) {
      show("Your email is already verified.", "success");
      optionalElement("[data-verified-actions]", HTMLElement)?.removeAttribute("hidden");
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
        show(errorMessage(error), "error");
      } finally {
        resend.disabled = false;
      }
    });
  }

  async function setupAccount() {
    let account: AccountResponse;
    try {
      account = await currentAccount();
    } catch {
      window.location.replace(
        `/login.html?return=${encodeURIComponent(location.pathname + location.search)}`
      );
      return;
    }
    input(accountForm(), "displayName").value = account.user.displayName || "";
    input(accountForm(), "email").value = account.user.email;
    const verified = optionalElement("[data-verification-state]", HTMLElement);
    if (verified) {
      verified.textContent = account.user.emailVerified ? "Verified" : "Verification required";
      verified.dataset.verified = scalarText(account.user.emailVerified);
    }
    accountForm().addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!accountForm().reportValidity()) return;
      const values = formValues();
      if (values.newPassword && values.newPassword !== values.confirmPassword) {
        show("New passwords do not match.", "error");
        return;
      }
      setBusy(true, "Saving...");
      try {
        const payload: Record<string, string | undefined> = {
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
        input(accountForm(), "currentPassword").value = "";
        input(accountForm(), "newPassword").value = "";
        input(accountForm(), "confirmPassword").value = "";
        show(data.message, "success");
        if (verified) {
          verified.textContent = data.user.emailVerified ? "Verified" : "Verification required";
          verified.dataset.verified = scalarText(data.user.emailVerified);
        }
      } catch (error) {
        show(errorMessage(error), "error");
      } finally {
        setBusy(false);
      }
    });
    optionalElement("[data-revoke-sessions]", HTMLButtonElement)?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      try {
        const data = await api(
          "/api/account/sessions/revoke-others",
          jsonOptions("POST", {}, account.csrfToken)
        );
        show(data.message, "success");
      } catch (error) {
        show(errorMessage(error), "error");
      } finally {
        button.disabled = false;
      }
    });
    setupLogout(account);
  }

  function setupLogout(account: AccountResponse) {
    document.querySelectorAll("[data-logout]").forEach((button) => {
      if (!(button instanceof HTMLButtonElement)) return;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api("/api/account/logout", jsonOptions("POST", {}, account.csrfToken));
          window.location.assign("/");
        } catch (error) {
          show(errorMessage(error), "error");
          button.disabled = false;
        }
      });
    });
  }

  function renderLibrary(books: LibraryBook[], account: AccountResponse) {
    const grid = element("[data-library-grid]", HTMLElement);
    const empty = element("[data-library-empty]", HTMLElement);
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
            show(errorMessage(error), "error");
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
    let account: AccountResponse;
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
      if (error instanceof AppError && error.status === 401) {
        window.location.replace(`/login.html?return=${encodeURIComponent(location.pathname)}`);
      } else {
        show(errorMessage(error), "error");
      }
    } finally {
      optionalElement("[data-library-loading]", HTMLElement)?.setAttribute("hidden", "");
    }
  }

  async function setupClaim() {
    const token = fragmentToken();
    const actions = optionalElement("[data-claim-auth-actions]", HTMLElement);
    if (!token) {
      show("This purchase-claim link is missing or invalid.", "error");
      return;
    }
    let account: AccountResponse;
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
      const verify = optionalElement("[data-claim-verify]", HTMLAnchorElement);
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
      optionalElement("[data-claim-complete]", HTMLElement)?.removeAttribute("hidden");
    } catch (error) {
      show(errorMessage(error), "error");
    }
  }

  const setups: Record<string, () => Promise<void>> = {
    login: setupLogin,
    register: setupRegister,
    forgot: setupForgot,
    reset: setupReset,
    verify: setupVerify,
    account: setupAccount,
    library: setupLibrary,
    claim: setupClaim,
  };
  const setup = setups[page || ""];
  if (setup) void setup().catch((error: unknown) => show(errorMessage(error), "error"));
})();
