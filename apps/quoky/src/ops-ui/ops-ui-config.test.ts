import { describe, expect, it } from 'vitest';

import { OPS_UI_DEFAULT_PORT, OpsUiConfigErrorCode, loadOpsUiConfig, opsUiDataDir } from './ops-ui-config';

const HOST_DB = '/Users/owner/Library/Application Support/Quoky/quoky.db';

describe('OPS-1 configuration (ADR-0113 D1–D3)', () => {
  it('is off by default (no port is opened)', () => {
    expect(loadOpsUiConfig({}, HOST_DB)).toEqual({ enabled: false });
    expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: '' }, HOST_DB)).toEqual({ enabled: false });
    expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: 'false', QUOKY_OPS_UI_PORT: '1' }, HOST_DB)).toEqual({ enabled: false });
  });

  it('enables on exactly "true", on port 47613 by default, with the token in the host data directory', () => {
    expect(OPS_UI_DEFAULT_PORT).toBe(47613);
    expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: 'true' }, HOST_DB)).toEqual({
      enabled: true,
      port: 47613,
      tokenFilePath: '/Users/owner/Library/Application Support/Quoky/ops-ui.token',
    });
    expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: 'true', QUOKY_OPS_UI_PORT: '1024' }, './data/chunsik.db', '/repo')).toEqual({
      enabled: true,
      port: 1024,
      tokenFilePath: '/repo/data/ops-ui.token',
    });
    expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: 'true', QUOKY_OPS_UI_PORT: '65535' }, HOST_DB)).toMatchObject({ port: 65535 });
  });

  it('disables only the UI, with a code, on an invalid flag or port', () => {
    for (const value of ['TRUE', 'yes', '1', ' true']) {
      expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: value }, HOST_DB)).toEqual({
        enabled: false,
        invalid: OpsUiConfigErrorCode.OPS_UI_ENABLED_INVALID,
      });
    }
    for (const port of ['1023', '0', '65536', '80', '4761x', '-1', '47613.0', '999999']) {
      expect(loadOpsUiConfig({ QUOKY_OPS_UI_ENABLED: 'true', QUOKY_OPS_UI_PORT: port }, HOST_DB)).toEqual({
        enabled: false,
        invalid: OpsUiConfigErrorCode.OPS_UI_PORT_INVALID,
      });
    }
  });

  it('accepts no bind-address configuration', () => {
    const config = loadOpsUiConfig(
      { QUOKY_OPS_UI_ENABLED: 'true', QUOKY_OPS_UI_HOST: '0.0.0.0', QUOKY_OPS_UI_BIND: '0.0.0.0' },
      HOST_DB,
    );
    expect(Object.keys(config).sort()).toEqual(['enabled', 'port', 'tokenFilePath']);
  });

  it('uses <cwd>/data for an in-memory database', () => {
    expect(opsUiDataDir(':memory:', '/repo')).toBe('/repo/data');
  });
});
