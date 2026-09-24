/**
 * Адрес стандартного интерфейса OData для команд без явного url.
 *
 * Адрес знает автономный сервер: он регистрирует здесь поставщика, а команды
 * OData спрашивают у него адрес публикации проекта. Так команды не зависят от
 * менеджера сервера напрямую, как и команды с монопольным доступом к базе
 * (см. exclusiveInfobase).
 *
 * @module odataEndpoint
 */

/** Адрес OData либо причина, почему его нет. */
export type ODataEndpoint = { serviceRoot: string } | { problem: string };

/** Поставщик адреса OData. */
export interface ODataEndpointProvider {
	/**
	 * Адрес стандартного интерфейса OData проекта.
	 *
	 * @param root - Корень проекта вызова
	 */
	resolve(root: string | undefined): ODataEndpoint;
}

let provider: ODataEndpointProvider | undefined;

/**
 * Регистрирует поставщика адреса OData.
 *
 * @param next - Поставщик
 * @returns Отмена регистрации
 */
export function registerODataEndpointProvider(next: ODataEndpointProvider): { dispose(): void } {
	provider = next;
	return {
		dispose: () => {
			if (provider === next) {
				provider = undefined;
			}
		},
	};
}

/**
 * Адрес стандартного интерфейса OData проекта от автономного сервера.
 *
 * @param root - Корень проекта вызова
 * @returns Адрес либо причина его отсутствия
 */
export function resolveODataEndpoint(root: string | undefined): ODataEndpoint {
	return provider?.resolve(root) ?? {
		problem: 'Автономный сервер недоступен в этом окне. Передайте адрес своей публикации в параметре url.',
	};
}
