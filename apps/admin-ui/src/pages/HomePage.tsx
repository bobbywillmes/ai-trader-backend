import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Center,
  Grid,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { getAdminToken } from "../lib/api";
import { useLogin, useMe } from "../features/auth/hooks";

const features = [
  {
    title: "Signal-driven entries",
    body: "Receives trade signals from n8n automation and converts them into broker orders via Alpaca.",
  },
  {
    title: "Automated exit management",
    body: "Evaluates open positions every two seconds against configurable exit profiles — target %, stop loss, trailing stop, and max hold days.",
  },
  {
    title: "Full audit trail",
    body: "Every order intent, broker response, and position change is logged as a system event for complete traceability.",
  },
];

export function HomePage() {
  const token = getAdminToken();
  const { data: me, isLoading: checkingSession } = useMe(token);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const loginMutation = useLogin();

  if (checkingSession && token) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (me) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();

    try {
      await loginMutation.mutateAsync({ email, password });
      navigate("/dashboard", { replace: true });
    } catch {
      // error shown via loginMutation.error
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
        {/* Left — branding + description */}
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
                  Algorithmic Trading Backend
                </Text>
              </div>
            </Group>

            <Text size="lg" c="gray.3" lh={1.7}>
              A self-hosted trading backend that connects automation signals to
              live brokerage execution. Built to run strategies on Alpaca
              markets with full position tracking and automated exit management.
            </Text>

            <Stack gap="lg">
              {features.map((f) => (
                <Group key={f.title} gap="md" align="flex-start" wrap="nowrap">
                  <Box
                    mt={4}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--mantine-color-cyan-4)",
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    <Text fw={600} c="gray.2" size="sm">
                      {f.title}
                    </Text>
                    <Text c="dimmed" size="sm" lh={1.6}>
                      {f.body}
                    </Text>
                  </div>
                </Group>
              ))}
            </Stack>
          </Stack>
        </Grid.Col>

        {/* Right — login form */}
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
            <Stack gap="xs" mb="xl">
              <Title order={2} size="h3" c="white">
                Sign in
              </Title>
              <Text size="sm" c="dimmed">
                Admin access only.
              </Text>
            </Stack>

            <form onSubmit={handleLogin}>
              <Stack gap="md">
                <TextInput
                  label="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  required
                />

                <PasswordInput
                  label="Password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                />

                {loginMutation.isError && (
                  <Text size="sm" c="red.4">
                    {loginMutation.error instanceof Error
                      ? loginMutation.error.message
                      : "Login failed."}
                  </Text>
                )}

                <Button
                  type="submit"
                  fullWidth
                  color="cyan"
                  loading={loginMutation.isPending}
                  mt="xs"
                >
                  Sign in
                </Button>
              </Stack>
            </form>
          </Box>
        </Grid.Col>
      </Grid>
    </Box>
  );
}
