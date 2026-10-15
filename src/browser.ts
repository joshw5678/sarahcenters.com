import type { z } from "zod";
import { AppError, isRecord } from "../shared/contracts.js";

type ElementConstructor<T extends Element> = { new (): T };

export function element<T extends Element>(selector: string, ctor: ElementConstructor<T>, root: ParentNode = document): T {
  const found = root.querySelector(selector);
  if (!(found instanceof ctor)) throw new Error(`Missing or invalid page element: ${selector}`);
  return found;
}

export function optionalElement<T extends Element>(selector: string, ctor: ElementConstructor<T>, root: ParentNode = document): T | null {
  const found = root.querySelector(selector);
  if (found === null) return null;
  if (!(found instanceof ctor)) throw new Error(`Invalid page element: ${selector}`);
  return found;
}

export function input(form: HTMLFormElement, name: string): HTMLInputElement {
  const found = form.elements.namedItem(name);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing form input: ${name}`);
  return found;
}

export function formValues(form: HTMLFormElement): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(form)) {
    if (typeof value !== "string") throw new Error(`Expected text form field: ${key}`);
    values[key] = value;
  }
  return values;
}

export async function requestJson<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const data: unknown = await response.json().catch((): unknown => ({}));
  if (!response.ok) {
    const error = new AppError(isRecord(data) && typeof data.error === "string" ? data.error : "The request could not be completed.", response.status);
    if (isRecord(data) && typeof data.code === "string") error.code = data.code;
    throw error;
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new Error("The server returned an invalid response. Please refresh and try again.");
  return result.data;
}

export function jsonOptions(method: string, body: unknown, csrfToken = ""): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, body: JSON.stringify(body) };
}
