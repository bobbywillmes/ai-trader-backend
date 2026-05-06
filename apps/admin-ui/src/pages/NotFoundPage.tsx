import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section>
      <h1 className="mb-2 text-2xl font-bold">Page not found</h1>
      <p className="mb-4 text-slate-400">
        This admin route does not exist.
      </p>
      <Link className="text-blue-400 hover:text-blue-300" to="/dashboard">
        Back to dashboard
      </Link>
    </section>
  );
}