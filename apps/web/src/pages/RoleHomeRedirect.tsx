import { Navigate } from "react-router-dom";

import { getAuthenticatedHomePath } from "../features/auth/roleUtils";
import { useAuth } from "../features/auth/useAuth";

export function RoleHomeRedirect() {
  const { access } = useAuth();

  return <Navigate to={getAuthenticatedHomePath(access)} replace />;
}
