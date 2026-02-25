import { withCommonJsHandler } from '../_bridge';
import handler from '../../../frontend/api/agent/[shortAddr]';

export default withCommonJsHandler(handler);
