import { NewDraftPage } from '@/features/versions/new-draft-page';
import { COST_MODELS } from '@/features/versions/kinds';
import { VersionEditorPage } from '@/features/versions/version-editor-page';
import { VersionListPage } from '@/features/versions/version-list-page';
import { CostModelForm } from './cost-model-form';

export function CostModelListPage() {
  return <VersionListPage config={COST_MODELS} />;
}

export function CostModelNewPage() {
  return <NewDraftPage config={COST_MODELS} Form={CostModelForm} />;
}

export function CostModelEditorPage() {
  return <VersionEditorPage config={COST_MODELS} Form={CostModelForm} />;
}
