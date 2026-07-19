declare const turnIdBrand: unique symbol;

export type TurnID = string & { readonly [turnIdBrand]: true };
