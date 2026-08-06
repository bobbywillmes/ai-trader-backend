import { Box, Image, Text, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import cx from 'clsx';

import aiTraderMark from '../../assets/branding/ai-trader-mark.png';
import classes from './AppBrand.module.css';

type AppBrandProps = {
  expanded: boolean;
};

export function AppBrand({ expanded }: AppBrandProps) {
  return (
    <UnstyledButton
      component={Link}
      to="/dashboard"
      className={cx(classes.brandLink, {
        [classes.collapsed]: !expanded,
      })}
      aria-label="AI Trader dashboard"
      title={!expanded ? 'Dashboard' : undefined}
    >
      <Image
        src={aiTraderMark}
        alt=""
        aria-hidden="true"
        className={classes.mark}
      />

      {expanded && (
        <Box className={classes.text}>
          <Text fw={700} size="md" lh={1.15}>
            AI Trader
          </Text>

          <Text c="dimmed" size="xs" lh={1.2}>
            Admin Console
          </Text>
        </Box>
      )}
    </UnstyledButton>
  );
}