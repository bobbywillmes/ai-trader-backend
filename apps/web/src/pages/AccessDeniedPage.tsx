import { Alert, Button, Stack } from "@mantine/core";
import { Link } from "react-router-dom";

export function AccessDeniedPage() {
  return <Stack maw={640} mx="auto" mt="xl">
    <Alert color="red" title="Access denied">
      Your platform role does not allow access to this area.
    </Alert>
    <Button component={Link} to="/dashboard" variant="light" w="fit-content">Return to Dashboard</Button>
  </Stack>;
}
