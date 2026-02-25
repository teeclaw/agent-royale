import { withCommonJsHandler } from './_bridge';
import handler from '../../frontend/api/health';

export default withCommonJsHandler(handler);
