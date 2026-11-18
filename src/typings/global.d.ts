
declare var VERSION: string;
declare var DEBUG: boolean;

declare module "*.html" {
    const content: string;
    export default content;
}
