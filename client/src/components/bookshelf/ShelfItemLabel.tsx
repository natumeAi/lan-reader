export function ShelfItemLabel({ name, meta }: { name: string; meta: string }) {
  return (
    <>
      <span className="shelf-item-label">{name}</span>
      <span className="shelf-item-meta">{meta}</span>
    </>
  );
}
