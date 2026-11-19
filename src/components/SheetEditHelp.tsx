import React from 'react';

export function SheetEditHelpContent() {
  return <div className="space-y-2">
      <h3 className="font-semibold">Editing your Google Sheets data</h3>
      <p>Admins can edit mapped company, ingredient, and product fields. Formula cells are read only.</p>
      <p>Shutfey uses a permanent ID and a hidden tag to find the record. Keep the ID and tag in place. When enabling editing, keep the mapped tabs still while Shutfey tags existing rows.</p>
      <p>Sort complete rows. Sorting part of a row can mix information from different records. Keep the mapped columns in place while editing.</p>
      <p>Shutfey saves only changed fields and checks the result. A change to the same field since you opened it requires a fresh review. A simultaneous change in Google Sheets can still overwrite a value.</p>
      <p>If Shutfey cannot confirm a change, the sheet may already have changed. Refresh and review the record in Google Sheets before saving again.</p>
      <p>Google Sheets remains the source of your records.</p>
  </div>;
}
