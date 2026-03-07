import { FormEvent, useState } from "react";

interface Props {
  onSubmit: (username: string, password: string) => Promise<void>;
  error?: string;
}

export function LoginForm({ onSubmit, error }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await onSubmit(username, password);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card stack">
      <h2>Sign In</h2>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button disabled={loading}>{loading ? "Signing In..." : "Sign In"}</button>
    </form>
  );
}
