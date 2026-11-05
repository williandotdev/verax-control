import { NewDraftPage } from '@/features/versions/new-draft-page';
import { PRICING_TABLES } from '@/features/versions/kinds';
import { VersionEditorPage } from '@/features/versions/version-editor-page';
import { VersionListPage } from '@/features/versions/version-list-page';
import { CheckPanel } from './check-panel';
import { PricingTableForm } from './pricing-table-form';

export function PricingTableListPage() {
  return <VersionListPage config={PRICING_TABLES} />;
}

export function PricingTableNewPage() {
  return <NewDraftPage config={PRICING_TABLES} Form={PricingTableForm} />;
}

export function PricingTableEditorPage() {
  return <VersionEditorPage config={PRICING_TABLES} Form={PricingTableForm} Actions={CheckPanel} />;
}
