"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE, ACCESS_MAX_AGE_S, accessToken, safeEqual, safeNext } from "@/lib/access";

export async function unlock(formData: FormData): Promise<void> {
  const password = process.env.ACCESS_PASSWORD;
  const given = formData.get("password");
  const next = safeNext(formData.get("next"));
  if (!password) redirect(`/login?error=${encodeURIComponent("ACCESS_PASSWORD is not set on the server")}`);
  if (typeof given !== "string" || !safeEqual(given, password)) {
    redirect(`/login?error=${encodeURIComponent("Wrong password")}&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(ACCESS_COOKIE, await accessToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE_S,
  });
  redirect(next);
}
