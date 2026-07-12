import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Center,
  Grid,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";

import {
  useCompleteSetupAccount,
  useSetupAccountToken,
} from "../features/auth/hooks";

export function SetupAccountPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const setupQuery = useSetupAccountToken(token);
  const completeSetupMutation = useCompleteSetupAccount(token ?? "");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  const setupComplete = completeSetupMutation.isSuccess;
  const invitedEmail =
    completeSetupMutation.data?.user.email ??
    setupQuery.data?.user.email ??
    "";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setClientError(null);

    if (!token) {
      setClientError("Setup token is missing.");
      return;
    }

    if (password.length < 12) {
      setClientError("Password must be at least 12 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setClientError("Passwords must match.");
      return;
    }

    try {
      await completeSetupMutation.mutateAsync({
        password,
        confirmPassword,
      });
    } catch {
      // error rendered from mutation state
    }
  }

  return (
    <Box
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top left, rgba(6, 182, 212, 0.12), transparent 40%), #0f172a",
      }}
    >
      <Grid style={{ minHeight: "100vh" }}>
        <Grid.Col
          span={{ base: 12, md: 7 }}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "3rem 4rem",
          }}
        >
          <Stack gap="xl" maw={520}>
            <Group gap="sm">
              <ThemeIcon size={48} radius="md" color="cyan" variant="filled">
                <Text size="lg" fw={800} c="white">
                  AT
                </Text>
              </ThemeIcon>
              <div>
                <Title order={1} size="h2" fw={700} c="white">
                  AI Trader
                </Title>
                <Text size="sm" c="dimmed">
                  Admin Account Setup
                </Text>
              </div>
            </Group>

            <Text size="lg" c="gray.3" lh={1.7}>
              Create your password to finish admin account setup. Setup links
              are one-time use and expire automatically.
            </Text>
          </Stack>
        </Grid.Col>

        <Grid.Col
          span={{ base: 12, md: 5 }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "3rem 2rem",
            borderLeft: "1px solid var(--mantine-color-dark-5)",
          }}
        >
          <Box w="100%" maw={380}>
            {!token ? (
              <Alert
                color="red"
                icon={<IconAlertCircle size={18} />}
                title="Invalid setup link"
              >
                Setup token is missing.
              </Alert>
            ) : setupQuery.isLoading ? (
              <Center h={220}>
                <Loader />
              </Center>
            ) : setupQuery.isError ? (
              <Alert
                color="red"
                icon={<IconAlertCircle size={18} />}
                title="Invalid setup link"
              >
                {setupQuery.error instanceof Error
                  ? setupQuery.error.message
                  : "This setup link is invalid or expired."}
              </Alert>
            ) : setupComplete ? (
              <Stack gap="md">
                <Alert
                  color="green"
                  icon={<IconCheck size={18} />}
                  title="Account setup complete"
                >
                  {invitedEmail} can now sign in.
                </Alert>
                <Button component={Link} to="/login" fullWidth color="cyan">
                  Go to Login
                </Button>
              </Stack>
            ) : (
              <>
                <Stack gap="xs" mb="xl">
                  <Title order={2} size="h3" c="white">
                    Set password
                  </Title>
                  <Text size="sm" c="dimmed">
                    {invitedEmail}
                  </Text>
                </Stack>

                <form onSubmit={handleSubmit}>
                  <Stack gap="md">
                    <PasswordInput
                      label="Password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) =>
                        setPassword(event.currentTarget.value)
                      }
                      required
                    />

                    <PasswordInput
                      label="Confirm password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.currentTarget.value)
                      }
                      required
                    />

                    {(clientError || completeSetupMutation.isError) && (
                      <Text size="sm" c="red.4">
                        {clientError ??
                          (completeSetupMutation.error instanceof Error
                            ? completeSetupMutation.error.message
                            : "Account setup failed.")}
                      </Text>
                    )}

                    <Button
                      type="submit"
                      fullWidth
                      color="cyan"
                      loading={completeSetupMutation.isPending}
                    >
                      Set Password
                    </Button>
                  </Stack>
                </form>
              </>
            )}
          </Box>
        </Grid.Col>
      </Grid>
    </Box>
  );
}
