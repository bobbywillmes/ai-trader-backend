import { useState } from "react";
import {
  Modal,
  PasswordInput,
  Button,
  Stack,
  Group,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useChangePassword, useVerifyPassword } from "./hooks";

interface ChangePasswordModalProps {
  opened: boolean;
  onClose: () => void;
  token: string;
}

export function ChangePasswordModal({
  opened,
  onClose,
  token,
}: ChangePasswordModalProps) {
  const [step, setStep] = useState<0 | 1>(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const verifyMutation = useVerifyPassword(token);
  const mutation = useChangePassword(token);

  function handleStep1Continue() {
    if (!currentPassword.trim()) {
      setError("Current password is required.");
      return;
    }

    verifyMutation.mutate(currentPassword, {
      onSuccess: () => {
        setError(null);
        setStep(1);
      },
      onError: (err) => {
        const message =
          err instanceof Error ? err.message : "Failed to verify password.";
        setError(message);
      },
    });
  }

  function handleStep2Submit() {
    const errors: string[] = [];

    if (!newPassword) {
      errors.push("New password is required.");
    } else if (newPassword.length < 12) {
      errors.push("Password must be at least 12 characters.");
    }

    if (!confirmPassword) {
      errors.push("Password confirmation is required.");
    }

    if (newPassword !== confirmPassword) {
      errors.push("Passwords do not match.");
    }

    if (currentPassword === newPassword) {
      errors.push("New password must differ from current password.");
    }

    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }

    mutation.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          notifications.show({
            message: "Password changed successfully.",
            color: "teal",
          });
          handleClose();
        },
        onError: (err) => {
          const message =
            err instanceof Error ? err.message : "Failed to change password.";
          setError(message);
        },
      }
    );
  }

  function handleClose() {
    setStep(0);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    onClose();
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Change Password"
      centered
      size="md"
    >
      <Stack gap="md">
        <Text size="xs" c="dimmed">
          Step {step + 1} of 2
        </Text>

        {step === 0 ? (
          <>
            <div>
              <Text fw={600} size="sm" mb="xs">
                Confirm your identity
              </Text>
              <Text size="xs" c="dimmed" mb="md">
                Enter your current password to proceed.
              </Text>
            </div>

            {error && (
              <Text size="sm" c="red.4">
                {error}
              </Text>
            )}

            <PasswordInput
              label="Current password"
              placeholder="Enter current password"
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.currentTarget.value);
                setError(null);
              }}
              disabled={verifyMutation.isPending}
              autoComplete="current-password"
            />

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={handleClose} disabled={verifyMutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={handleStep1Continue}
                disabled={verifyMutation.isPending}
                loading={verifyMutation.isPending}
              >
                Continue
              </Button>
            </Group>
          </>
        ) : (
          <>
            <div>
              <Text fw={600} size="sm" mb="xs">
                Set new password
              </Text>
              <Text size="xs" c="dimmed" mb="md">
                Choose a secure password (at least 12 characters).
              </Text>
            </div>

            {error && (
              <Text size="sm" c="red.4">
                {error}
              </Text>
            )}

            <form autoComplete="false">
              <input autoComplete="false" name="hidden" type="text" style={{display:'none'}}></input>
              <PasswordInput
              label="New password"
              placeholder="Enter new password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.currentTarget.value);
                setError(null);
              }}
              disabled={mutation.isPending}
              autoComplete="off"
            />

            <PasswordInput
              label="Confirm password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.currentTarget.value);
                setError(null);
              }}
              disabled={mutation.isPending}
              autoComplete="new-password"
            />
            </form>

            <Stack gap="xs">
              <Text size="xs" c={newPassword.length >= 12 ? "green" : "red"}>
                {newPassword.length >= 12 ? "✓" : "✗"} Password must be at least 12 characters
              </Text>
              <Text size="xs" c={newPassword === confirmPassword && confirmPassword.length > 0 ? "green" : "red"}>
                {newPassword === confirmPassword && confirmPassword.length > 0 ? "✓" : "✗"} Passwords must match
              </Text>
            </Stack>

            <Group justify="flex-end" gap="sm">
              <Button
                variant="default"
                onClick={() => {
                  setStep(0);
                  setError(null);
                }}
                disabled={mutation.isPending}
              >
                Back
              </Button>
              <Button
                onClick={handleStep2Submit}
                disabled={
                  mutation.isPending ||
                  newPassword.length < 12 ||
                  newPassword !== confirmPassword ||
                  confirmPassword.length === 0 ||
                  currentPassword === newPassword
                }
                loading={mutation.isPending}
              >
                Change Password
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
