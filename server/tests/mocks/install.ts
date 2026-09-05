import { setConfig } from '../../db/repos/operations';
import { __setHubSpotServiceForTests } from '../../services/hubspot';
import { __setOutlookServiceForTests } from '../../services/outlook';
import { resetVerifyCacheForTests } from '../../routes/status';
import { RADAR_HUBSPOT_STAGES } from '../../../shared/integrations';
import { MockHubSpot } from './hubspot';
import { MockOutlook } from './outlook';

/** Install the in-memory integration fixtures for a test. */
export function installMockIntegrations(): void {
  __setHubSpotServiceForTests(new MockHubSpot());
  __setOutlookServiceForTests(new MockOutlook());
  resetVerifyCacheForTests();
}

/** Remove fixtures so tests can assert honest not-connected behavior. */
export function uninstallMockIntegrations(): void {
  __setHubSpotServiceForTests(null);
  __setOutlookServiceForTests(null);
  resetVerifyCacheForTests();
}

/** A complete radar-stage → fixture-stage mapping (sync routes require one). */
export function installTestPipelineMapping(): void {
  setConfig('hubspot-pipeline-mapping', {
    stages: Object.fromEntries(
      RADAR_HUBSPOT_STAGES.map((s) => [s, { pipelineId: 'test-pipeline', stageId: `test-${s.toLowerCase().replace(/\s+/g, '-')}` }]),
    ),
  });
}
