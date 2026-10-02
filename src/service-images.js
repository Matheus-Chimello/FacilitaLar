const serviceImages = [
  { image: '/assets/images/faxineira.png', label: 'Limpeza residencial', categories: ['Limpeza residencial'] },
  { image: '/assets/images/encanador.jpg', label: 'Hidráulica', categories: ['Hidráulica'] },
  { image: '/assets/images/eletricista.jpg', label: 'Elétrica', categories: ['Elétrica'] },
  { image: '/assets/images/baba.jpg', label: 'Cuidados familiares', categories: ['Cuidados', 'Babás'] },
  { image: '/assets/images/jardineiro.jpg', label: 'Jardinagem', categories: ['Jardinagem'] },
  { image: '/assets/images/limpador de piscina.jpg', label: 'Piscina', categories: ['Piscina'] },
  { image: '/assets/images/montador de móveis.jpg', label: 'Montagem de móveis', categories: ['Montagem'] },
  { image: '/assets/images/Limpador de Calha.jpg', label: 'Telhados e calhas', categories: ['Telhados e calhas'] },
  { image: '/assets/images/services/ar-condicionado.jpg', label: 'Ar-condicionado', categories: ['Ar-condicionado'] },
  { image: '/assets/images/services/chaveiro.jpg', label: 'Chaveiro', categories: ['Chaveiro'] },
  { image: '/assets/images/services/cuidados-com-idosos.jpg', label: 'Cuidados com idosos', categories: ['Cuidados com idosos'] },
  { image: '/assets/images/services/cuidados-com-pets.jpg', label: 'Cuidados com pets', categories: ['Cuidados com pets'] },
  { image: '/assets/images/services/dedetizacao.jpg', label: 'Dedetização', categories: ['Dedetização'] },
  { image: '/assets/images/services/eletrodomesticos.jpg', label: 'Eletrodomésticos', categories: ['Eletrodomésticos'] },
  { image: '/assets/images/services/gesso-e-drywall.jpg', label: 'Gesso e drywall', categories: ['Gesso e drywall'] },
  { image: '/assets/images/services/impermeabilizacao.jpg', label: 'Impermeabilização', categories: ['Impermeabilização'] },
  { image: '/assets/images/services/informatica-e-redes.jpg', label: 'Informática e redes', categories: ['Informática e redes'] },
  { image: '/assets/images/services/lavanderia-e-passadoria.jpg', label: 'Lavanderia e passadoria', categories: ['Lavanderia e passadoria'] },
  { image: '/assets/images/services/limpeza-pos-obra.jpg', label: 'Limpeza pós-obra', categories: ['Limpeza pós-obra'] },
  { image: '/assets/images/services/manutencao-geral.jpg', label: 'Manutenção geral', categories: ['Manutenção geral'] },
  { image: '/assets/images/services/marcenaria.jpg', label: 'Marcenaria', categories: ['Marcenaria'] },
  { image: '/assets/images/services/mudancas-e-fretes.jpg', label: 'Mudanças e fretes', categories: ['Mudanças e fretes'] },
  { image: '/assets/images/services/organizacao-de-ambientes.jpg', label: 'Organização de ambientes', categories: ['Organização de ambientes'] },
  { image: '/assets/images/services/pintura.jpg', label: 'Pintura', categories: ['Pintura'] },
  { image: '/assets/images/services/reformas-e-alvenaria.jpg', label: 'Reformas e alvenaria', categories: ['Reformas e alvenaria'] },
  { image: '/assets/images/services/seguranca-eletronica.jpg', label: 'Segurança eletrônica', categories: ['Segurança eletrônica'] },
  { image: '/assets/images/services/serralheria.jpg', label: 'Serralheria', categories: ['Serralheria'] },
  { image: '/assets/images/services/vidracaria.jpg', label: 'Vidraçaria', categories: ['Vidraçaria'] },
];

const genericImage = '/assets/images/services-bg.jpg';
const imageOptions = serviceImages.map(({ image }) => image);
const imageLabels = serviceImages.map(({ label }) => label);
const normalize = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');

function defaultCategoryImage(name) {
  return serviceImages.find(({ categories }) => categories.some((category) => normalize(category) === normalize(name)))?.image || genericImage;
}

function categoryImage(category) {
  if (imageOptions.includes(category?.image) || category?.image === genericImage) return category.image;
  return defaultCategoryImage(category?.name);
}

function imagesForCategory(category) {
  return category ? [categoryImage(category)] : [];
}

module.exports = { serviceImages, imageOptions, imageLabels, genericImage, defaultCategoryImage, categoryImage, imagesForCategory };
