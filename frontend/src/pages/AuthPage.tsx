import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Spinner } from "../components/ui";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { user, loading, login, signup } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }
  if (user) {
    return <Navigate to="/" replace />;
  }

  const isSignup = mode === "signup";

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors([]);
    setSubmitting(true);
    try {
      await (isSignup ? signup(email, password) : login(email, password));
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        // A 400 carries per-field detail worth showing; anything else has one message.
        const fieldMessages = err.fieldMessages();
        setErrors(fieldMessages.length > 0 ? fieldMessages : [err.message]);
      } else {
        setErrors(["Something went wrong. Please try again."]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto mt-24 w-full max-w-sm px-4">
      <h1 className="text-center text-2xl font-semibold tracking-tight text-indigo-600">lookout</h1>
      <p className="mt-1 text-center text-sm text-gray-500">URL health and observability</p>

      <form onSubmit={onSubmit} className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-medium text-gray-900">
          {isSignup ? "Create an account" : "Sign in"}
        </h2>

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="mt-3 block text-sm font-medium text-gray-700">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          />
          {isSignup ? (
            <span className="mt-1 block text-xs font-normal text-gray-500">
              At least 8 characters.
            </span>
          ) : null}
        </label>

        {errors.length > 0 ? (
          <ul className="mt-3 space-y-1 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? <Spinner className="align-middle" /> : isSignup ? "Sign up" : "Sign in"}
          </Button>
          <button
            type="button"
            onClick={() => navigate(isSignup ? "/login" : "/signup")}
            className="text-sm text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
          >
            {isSignup ? "Have an account? Sign in" : "Need an account? Sign up"}
          </button>
        </div>
      </form>
    </div>
  );
}
